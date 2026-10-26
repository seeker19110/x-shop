import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IAuthModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import { createAdmin, createMfaAdmin, type MfaAdmin } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-138 (BE-AUTH-003, D-068) — đăng ký emailpass không dùng để dò/chiếm trước tài khoản:
 *  - `POST /auth/<actor>/<provider>/register` chỉ cho actor `user` + `emailpass` khi có lời mời admin hợp lệ (token mời
 *    trong thân, hoặc lời mời còn hạn cho đúng email — trang mời của dashboard Medusa không gửi token khi đăng ký);
 *    còn lại (email admin có thật, email lạ, actor `customer`/lạ, đường dẫn mã hoá %xx) → CÙNG một phản hồi, không tạo
 *    auth_identity. Identity emailpass dùng chung mọi actor (entity_id = email) nên đăng ký `customer` cũng dò/chiếm được
 *    email admin — đóng ở P0 (tài khoản khách là P1, đặc tả §1.1, POST04).
 *  - rate limit theo (email + IP), email, IP cho mọi `/auth/<actor>/<provider>/register` và đăng nhập
 *    `/auth/<actor>/emailpass` (bộ đếm đăng nhập theo email dùng chung mọi actor — không lách qua route khách).
 */

interface RawRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
}

let ipSeq = 0;
const newIp = () => `203.0.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let base: URL;
    let container: MedusaContainer;

    beforeAll(() => {
      base = new URL(String((api as unknown as { defaults: { baseURL: string } }).defaults.baseURL));
      container = getContainer();
    });

    /** Request thô — giữ nguyên đường dẫn (kể cả `%75`), không để client chuẩn hoá. */
    function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<RawRes> {
      const text = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: base.hostname,
            port: base.port,
            path,
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": newIp(), ...headers },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              let json: Record<string, unknown> = {};
              try {
                json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
              } catch {
                // không phải JSON
              }
              resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
            });
          },
        );
        req.on("error", reject);
        req.end(text);
      });
    }

    const withoutTrace = (r: RawRes) => {
      const { trace_id: _t, ...rest } = r.json;
      return { status: r.status, body: rest };
    };

    const identityCount = async (email: string) =>
      (
        await container
          .resolve<IAuthModuleService>(Modules.AUTH)
          .listProviderIdentities({ entity_id: email, provider: "emailpass" })
      ).length;

    const password = "MatKhau-ThuNghiem-123";
    const unknownEmail = () => `la-${randomUUID()}@x-shop.test`;

    // Test runner dọn DB sau mỗi ca → owner (có MFA, quyền user.manage để mời) tạo lại theo từng ca.
    let owner: MfaAdmin | undefined;
    beforeEach(() => {
      owner = undefined;
    });
    const invite = async (email: string) => {
      owner ??= await createMfaAdmin(api as never, container, { roles: ["owner"] });
      const res = (await api.post("/admin/invites", { email }, {
        headers: owner.headers,
        validateStatus: () => true,
      } as never)) as unknown as { status: number; data: { invite: { id: string; token: string } } };
      expect({ status: res.status, data: res.data }).toMatchObject({
        status: 200,
        data: { invite: { email } },
      });
      return res.data.invite;
    };

    describe("đăng ký không lộ tài khoản tồn tại, không tạo identity khi không có lời mời", () => {
      it("actor user: email admin có thật vs email lạ → cùng status + thân (trừ trace_id); không tạo auth_identity", async () => {
        const admin = await createAdmin(api as never, container);
        const fresh = unknownEmail();
        const a = await post("/auth/user/emailpass/register", { email: admin.email, password });
        const b = await post("/auth/user/emailpass/register", { email: fresh, password });
        expect(a.status).toBe(400);
        expect(withoutTrace(b)).toEqual(withoutTrace(a));
        expect(a.json).toMatchObject({ code: "REGISTRATION_NOT_ALLOWED" });
        expect(a.json.trace_id).not.toBe(b.json.trace_id);
        expect(JSON.stringify(a.json)).not.toMatch(/already exists/i);
        expect(await identityCount(fresh)).toBe(0);
      });

      it("actor customer / actor lạ / đường dẫn mã hoá %xx: cùng phản hồi; email admin tương lai không bị chiếm trước", async () => {
        const admin = await createAdmin(api as never, container);
        const future = unknownEmail();
        const ref = withoutTrace(await post("/auth/user/emailpass/register", { email: future, password }));
        for (const path of [
          "/auth/customer/emailpass/register",
          "/auth/foo/emailpass/register",
          "/auth/%75ser/emailpass/register",
          "/auth/user/emailpas%73/register",
          "/AUTH/USER/EMAILPASS/REGISTER/",
        ]) {
          for (const email of [admin.email, future]) {
            const r = await post(path, { email, password });
            expect({ path, ...withoutTrace(r) }).toEqual({ path, ...ref });
          }
        }
        expect(await identityCount(future)).toBe(0);
        // Admin được mời sau đó vẫn đăng ký + nhận lời mời bình thường (không ai chiếm trước được identity).
        const inv = await invite(future);
        const reg = await post("/auth/user/emailpass/register", { email: future, password });
        expect(reg.status).toBe(200);
        const acc = await post(
          `/admin/invites/accept?token=${encodeURIComponent(inv.token)}`,
          { first_name: "Mới" },
          { authorization: `Bearer ${String(reg.json.token)}` },
        );
        expect(acc.status).toBe(200);
      });

      it("token mời sai / của email khác / lời mời đã hết hạn → cùng phản hồi chung, không tạo identity", async () => {
        const email = unknownEmail();
        const other = unknownEmail();
        const ref = withoutTrace(await post("/auth/user/emailpass/register", { email, password }));
        const invOther = await invite(other);
        await invite(email);
        const badToken = await post("/auth/user/emailpass/register", {
          email,
          password,
          invite_token: "khong-hop-le",
        });
        const wrongEmail = await post("/auth/user/emailpass/register", {
          email,
          password,
          invite_token: invOther.token,
        });
        expect(withoutTrace(badToken)).toEqual(ref);
        expect(withoutTrace(wrongEmail)).toEqual(ref);
        expect(await identityCount(email)).toBe(0);

        const expiredEmail = unknownEmail();
        const exp = await invite(expiredEmail);
        // Kiểu UpdateInviteDTO không có expires_at → đặt hết hạn thẳng ở DB (chỉ trong test).
        await container
          .resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION)("invite")
          .where({ id: exp.id })
          .update({ expires_at: new Date(Date.now() - 60_000) });
        expect(
          withoutTrace(await post("/auth/user/emailpass/register", { email: expiredEmail, password })),
        ).toEqual(ref);
        expect(
          withoutTrace(
            await post("/auth/user/emailpass/register", {
              email: expiredEmail,
              password,
              invite_token: exp.token,
            }),
          ),
        ).toEqual(ref);
        expect(await identityCount(expiredEmail)).toBe(0);
      });
    });

    describe("luồng mời admin (invite → register → accept → đăng nhập) vẫn xanh", () => {
      it("như trang mời của dashboard Medusa: register KHÔNG kèm token (lời mời còn hạn cho đúng email) → accept → login", async () => {
        const email = unknownEmail();
        const inv = await invite(email);
        const reg = await post("/auth/user/emailpass/register", { email, password });
        expect(reg.status).toBe(200);
        expect(typeof reg.json.token).toBe("string");
        const acc = await post(
          `/admin/invites/accept?token=${encodeURIComponent(inv.token)}`,
          { first_name: "Nhân", last_name: "Viên" },
          { authorization: `Bearer ${String(reg.json.token)}` },
        );
        expect(acc.status).toBe(200);
        expect((acc.json.user as { email: string }).email).toBe(email);
        const login = await post("/auth/user/emailpass", { email, password });
        expect(login.status).toBe(200);
        // Lời mời đã dùng → đăng ký lại cho email khác cùng token bị từ chối.
        const reuse = await post("/auth/user/emailpass/register", {
          email: unknownEmail(),
          password,
          invite_token: inv.token,
        });
        expect(reuse.status).toBe(400);
      });

      it("register kèm `invite_token` hợp lệ đúng email → 200; accept → user được tạo", async () => {
        const email = unknownEmail();
        const inv = await invite(email);
        const reg = await post("/auth/user/emailpass/register", { email, password, invite_token: inv.token });
        expect(reg.status).toBe(200);
        const acc = await post(
          `/admin/invites/accept?token=${encodeURIComponent(inv.token)}`,
          {},
          { authorization: `Bearer ${String(reg.json.token)}` },
        );
        expect(acc.status).toBe(200);
      });
    });

    describe("rate limit đăng ký/đăng nhập (SEC03): 429 + Retry-After", () => {
      const expect429 = (r: RawRes) => {
        expect(r.status).toBe(429);
        expect(r.json).toMatchObject({ code: "RATE_LIMITED" });
        expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      };

      it("register theo (email + IP): song song vượt ngưỡng → đúng `perIdentityIp` lượt lọt, phần còn lại 429", async () => {
        const email = unknownEmail();
        const ip = newIp();
        const n = AUTH_RATE_LIMITS.register.perIdentityIp;
        const results = await Promise.all(
          Array.from({ length: n + 4 }, () =>
            post("/auth/customer/emailpass/register", { email, password }, { "x-forwarded-for": ip }),
          ),
        );
        expect(results.filter((r) => r.status !== 429)).toHaveLength(n);
        expect429(results.find((r) => r.status === 429)!);
        // Email khác cùng IP chưa bị chặn theo email + IP.
        expect(
          (
            await post(
              "/auth/customer/emailpass/register",
              { email: unknownEmail(), password },
              { "x-forwarded-for": ip },
            )
          ).status,
        ).toBe(400);
      });

      it("register theo email (mọi IP) và theo IP (mọi email) → 429", async () => {
        const email = unknownEmail();
        for (let i = 0; i < AUTH_RATE_LIMITS.register.perIdentity; i++) {
          expect((await post("/auth/user/emailpass/register", { email, password })).status).toBe(400);
        }
        expect429(await post("/auth/user/emailpass/register", { email, password }));

        const ip = newIp();
        for (let i = 0; i < AUTH_RATE_LIMITS.register.perIp; i++) {
          expect(
            (
              await post(
                "/auth/foo/emailpass/register",
                { email: unknownEmail(), password },
                { "x-forwarded-for": ip },
              )
            ).status,
          ).toBe(400);
        }
        expect429(
          await post(
            "/auth/foo/emailpass/register",
            { email: unknownEmail(), password },
            { "x-forwarded-for": ip },
          ),
        );
      });

      it("đăng nhập: thất bại qua /auth/customer, /auth/%75ser cộng chung bộ đếm email của admin → /auth/user/emailpass 429", async () => {
        const admin = await createAdmin(api as never, container);
        const ip = newIp();
        const h = { "x-forwarded-for": ip };
        const bad = { email: admin.email, password: "sai-mat-khau-0123" };
        expect((await post("/auth/customer/emailpass", bad, h)).status).toBe(401);
        expect((await post("/auth/customer/emailpass", bad, h)).status).toBe(401);
        expect((await post("/auth/%75ser/emailpass", bad, h)).status).toBe(401);
        expect((await post("/auth/foo/emailpass", bad, h)).status).toBe(401);
        expect((await post("/auth/user/emailpass", bad, h)).status).toBe(401);
        expect(AUTH_RATE_LIMITS.login.perIdentityIp).toBe(5);
        expect429(await post("/auth/user/emailpass", { email: admin.email, password: admin.password }, h));
        // IP khác vẫn đăng nhập đúng được (chưa tới ngưỡng theo email).
        expect(
          (await post("/auth/user/emailpass", { email: admin.email, password: admin.password })).status,
        ).toBe(200);
      });
    });
  },
});
