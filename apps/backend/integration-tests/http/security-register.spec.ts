import { randomInt, randomUUID } from "node:crypto";
import http from "node:http";
import type { IAuthModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import { cleanupUnlinkedIdentityForInvite } from "../../src/lib/admin-security/invite-guard";
import { createAdmin, createMfaAdmin, jwtPayload, type MfaAdmin } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-138 (BE-AUTH-003, D-068, D-075) — đăng ký emailpass không dùng để dò/chiếm trước tài khoản:
 *  - `POST /auth/<actor>/<provider>/register` chỉ cho actor `user` + `emailpass` khi chứng minh có token mời hợp lệ đúng
 *    email (thân `invite_token`, hoặc `Referer` = trang mời dashboard `/app/invite?token=…` cùng host — trang mời của
 *    dashboard Medusa không gửi token khi đăng ký); còn lại (email admin có thật, email lạ, actor `customer`/lạ, đường dẫn mã hoá %xx) → CÙNG một phản hồi, không tạo
 *    auth_identity. Identity emailpass dùng chung mọi actor (entity_id = email) nên đăng ký `customer` cũng dò/chiếm được
 *    email admin — đóng ở P0 (tài khoản khách là P1, đặc tả §1.1, POST04).
 *  - rate limit theo (email + IP), email, IP cho mọi `/auth/<actor>/<provider>/register` và đăng nhập
 *    `/auth/<actor>/emailpass` (bộ đếm đăng nhập theo email dùng chung mọi actor — không lách qua route khách);
 *    GET/HEAD đăng nhập emailpass → 405 (không lách rate limit bằng GET có thân).
 *  - accept lời mời: email thân và identity trong Bearer phải khớp lời mời; xoá/gửi lại lời mời dọn identity chưa gắn actor.
 */

interface RawRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: Record<string, unknown>;
}

let ipSeq = 0;
const newIp = () => `203.0.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
/** Một /64 IPv6 ngẫu nhiên (bộ đếm Redis sống qua các ca/lần chạy trong cửa sổ) → hàm sinh địa chỉ thứ `i` trong dải. */
const newV6Net = () => {
  const g = () => randomInt(1, 0xffff).toString(16);
  const prefix = `2001:db8:${g()}:${g()}`;
  return (i: number) => `${prefix}:${(i % 0xfffe) + 1}:${g()}:${g()}:${g()}`;
};

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let base: URL;
    let container: MedusaContainer;

    beforeAll(() => {
      base = new URL(String((api as unknown as { defaults: { baseURL: string } }).defaults.baseURL));
      container = getContainer();
    });

    /** Request thô — giữ nguyên đường dẫn (kể cả `%75`), không để client chuẩn hoá; GET/HEAD cũng gửi được thân. */
    function send(
      method: string,
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ): Promise<RawRes> {
      const text = JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: base.hostname,
            port: base.port,
            path,
            method,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
              "x-forwarded-for": newIp(),
              ...headers,
            },
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
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      send("POST", path, body, headers);
    /** Referer của trang mời dashboard Medusa (cùng host với backend, `admin.path` mặc định `/app`). */
    const dashboardReferer = (token: string, host = base.host) => ({
      referer: `http://${host}/app/invite?token=${encodeURIComponent(token)}`,
    });
    /** Chờ subscriber (sự kiện chạy bất đồng bộ) — tối đa ~15 s. */
    async function eventually(check: () => Promise<boolean>) {
      for (let i = 0; i < 150; i++) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
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
    const asOwner = async (method: "post" | "delete", url: string) => {
      owner ??= await createMfaAdmin(api as never, container, { roles: ["owner"] });
      const cfg = { headers: owner.headers, validateStatus: () => true } as never;
      return (method === "post" ? await api.post(url, {}, cfg) : await api.delete(url, cfg)) as unknown as {
        status: number;
        data: Record<string, unknown>;
      };
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
        const reg = await post(
          "/auth/user/emailpass/register",
          { email: future, password },
          dashboardReferer(inv.token),
        );
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
        // Token thân sai thì Referer đúng không cứu được.
        expect(
          withoutTrace(
            await post(
              "/auth/user/emailpass/register",
              { email, password, invite_token: "khong-hop-le" },
              dashboardReferer(invOther.token),
            ),
          ),
        ).toEqual(ref);
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
      it("người lạ biết email đang được mời: không token / Referer khác host / sai token / sai trang → 400 chung, không tạo identity (D-075)", async () => {
        const email = unknownEmail();
        const ref = withoutTrace(
          await post("/auth/user/emailpass/register", { email: unknownEmail(), password }),
        );
        const inv = await invite(email);
        const other = await invite(unknownEmail());
        for (const headers of [
          {},
          dashboardReferer(inv.token, "evil.example"),
          dashboardReferer(inv.token, `${base.hostname}:1`),
          dashboardReferer(other.token),
          dashboardReferer("khong-hop-le"),
          { referer: `http://${base.host}/app/login?token=${encodeURIComponent(inv.token)}` },
          { referer: `http://${base.host}/app/invite` },
        ]) {
          const r = await post("/auth/user/emailpass/register", { email, password }, headers);
          expect({ headers, ...withoutTrace(r) }).toEqual({ headers, ...ref });
        }
        expect(await identityCount(email)).toBe(0);
        // Người được mời vẫn đăng ký được sau đó (không ai chiếm trước).
        expect(
          (await post("/auth/user/emailpass/register", { email, password }, dashboardReferer(inv.token)))
            .status,
        ).toBe(200);
      });

      it("như trang mời của dashboard Medusa: không token trong thân, Referer `/app/invite?token=` cùng host → accept → login", async () => {
        const email = unknownEmail();
        const inv = await invite(email);
        const reg = await post(
          "/auth/user/emailpass/register",
          { email, password },
          dashboardReferer(inv.token),
        );
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

    describe("accept lời mời ràng buộc email + identity; xoá/gửi lại lời mời dọn identity treo", () => {
      const userCount = async (email: string) =>
        (await container.resolve(Modules.USER).listUsers({ email })).length;

      it("accept với thân email khác lời mời → 400 INVITE_MISMATCH, không tạo user email lạ; đúng email → 200", async () => {
        const a = unknownEmail();
        const b = unknownEmail();
        const inv = await invite(a);
        const reg = await post("/auth/user/emailpass/register", {
          email: a,
          password,
          invite_token: inv.token,
        });
        expect(reg.status).toBe(200);
        const bearer = { authorization: `Bearer ${String(reg.json.token)}` };
        const url = `/admin/invites/accept?token=${encodeURIComponent(inv.token)}`;
        const bad = await post(url, { email: b }, bearer);
        expect(bad.status).toBe(400);
        expect(bad.json).toMatchObject({ code: "INVITE_MISMATCH" });
        expect(await userCount(b)).toBe(0);
        expect(await userCount(a)).toBe(0);
        const ok = await post(url, { email: a }, bearer);
        expect(ok.status).toBe(200);
        expect((ok.json.user as { email: string }).email).toBe(a);
      });

      it("accept token mời của A bằng identity của C → 400; không Bearer → bị từ chối", async () => {
        const a = unknownEmail();
        const c = unknownEmail();
        const invA = await invite(a);
        const invC = await invite(c);
        const regC = await post("/auth/user/emailpass/register", {
          email: c,
          password,
          invite_token: invC.token,
        });
        expect(regC.status).toBe(200);
        const url = `/admin/invites/accept?token=${encodeURIComponent(invA.token)}`;
        const cross = await post(url, {}, { authorization: `Bearer ${String(regC.json.token)}` });
        expect(cross.status).toBe(400);
        expect(cross.json).toMatchObject({ code: "INVITE_MISMATCH" });
        expect(await userCount(a)).toBe(0);
        expect(await userCount(c)).toBe(0);
        expect((await post(url, {})).status).toBeGreaterThanOrEqual(400);
        expect(await userCount(a)).toBe(0);
      });

      it("xoá lời mời → identity đã đăng ký (chưa accept) của đúng email bị dọn; email khác không bị chạm", async () => {
        const email = unknownEmail();
        const keep = unknownEmail();
        const inv = await invite(email);
        const invKeep = await invite(keep);
        expect(
          (await post("/auth/user/emailpass/register", { email, password, invite_token: inv.token })).status,
        ).toBe(200);
        expect(
          (
            await post("/auth/user/emailpass/register", {
              email: keep,
              password,
              invite_token: invKeep.token,
            })
          ).status,
        ).toBe(200);
        expect((await asOwner("delete", `/admin/invites/${inv.id}`)).status).toBe(200);
        expect(await eventually(async () => (await identityCount(email)) === 0)).toBe(true);
        expect(await identityCount(keep)).toBe(1);
      });

      it("gửi lại lời mời → identity treo bị dọn; đăng ký lại bằng token mới (mật khẩu khác) → 200, token cũ → 400", async () => {
        const email = unknownEmail();
        const inv = await invite(email);
        expect(
          (await post("/auth/user/emailpass/register", { email, password, invite_token: inv.token })).status,
        ).toBe(200);
        const resent = await asOwner("post", `/admin/invites/${inv.id}/resend`);
        expect(resent.status).toBe(200);
        const fresh = String((resent.data.invite as { token: string }).token);
        expect(fresh).not.toBe(inv.token);
        expect(await eventually(async () => (await identityCount(email)) === 0)).toBe(true);
        const pw2 = `${password}-moi`;
        expect(
          (await post("/auth/user/emailpass/register", { email, password: pw2, invite_token: inv.token }))
            .status,
        ).toBe(400);
        const reg = await post(
          "/auth/user/emailpass/register",
          { email, password: pw2 },
          dashboardReferer(fresh),
        );
        expect(reg.status).toBe(200);
        const acc = await post(
          `/admin/invites/accept?token=${encodeURIComponent(fresh)}`,
          {},
          { authorization: `Bearer ${String(reg.json.token)}` },
        );
        expect(acc.status).toBe(200);
      });

      it("dọn chỉ chạm identity CHƯA gắn actor: identity đã gắn actor (app_metadata.*_id) giữ nguyên", async () => {
        const email = unknownEmail();
        const inv = await invite(email);
        const reg = await post("/auth/user/emailpass/register", { email, password, invite_token: inv.token });
        expect(reg.status).toBe(200);
        const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
        const authIdentityId = String(jwtPayload(String(reg.json.token)).auth_identity_id);
        // Medusa không cho mời email đã là user → gắn actor thẳng vào identity để mô phỏng tài khoản đã có.
        await auth.updateAuthIdentities({ id: authIdentityId, app_metadata: { customer_id: "cus_da_co" } });
        expect(await cleanupUnlinkedIdentityForInvite(container, inv.id)).toBe(0);
        expect(await identityCount(email)).toBe(1);
        await auth.updateAuthIdentities({ id: authIdentityId, app_metadata: { customer_id: null } });
        expect(await cleanupUnlinkedIdentityForInvite(container, inv.id)).toBe(1);
        expect(await identityCount(email)).toBe(0);
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

      it("IPv6 gộp /64 (T-148): sai mật khẩu với XFF xoay trong một /64 → 429 đúng ngưỡng IP; /64 khác vẫn thử được", async () => {
        const net = newV6Net();
        const n = AUTH_RATE_LIMITS.login.perIp;
        const bad = () => ({ email: unknownEmail(), password: "sai-mat-khau-0123" });
        for (let i = 0; i < n; i++) {
          const r = await post("/auth/user/emailpass", bad(), { "x-forwarded-for": net(i) });
          expect({ i, status: r.status }).toEqual({ i, status: 401 });
        }
        expect429(await post("/auth/user/emailpass", bad(), { "x-forwarded-for": net(n) }));
        // Dạng viết khác (số 0 đầu, chữ hoa) của địa chỉ trong cùng /64 cũng bị chặn.
        const upper = net(n + 1)
          .split(":")
          .map((part) => part.toUpperCase().padStart(4, "0"))
          .join(":");
        expect429(await post("/auth/user/emailpass", bad(), { "x-forwarded-for": upper }));
        expect((await post("/auth/user/emailpass", bad(), { "x-forwarded-for": newV6Net()(0) })).status).toBe(
          401,
        );
      });

      it("IPv6 gộp /64 (T-148): một email, địa chỉ xoay trong /64 → chặn theo (email + IP) sau `perIdentityIp`", async () => {
        const admin = await createAdmin(api as never, container);
        const net = newV6Net();
        const bad = { email: admin.email, password: "sai-mat-khau-0123" };
        expect(AUTH_RATE_LIMITS.login.perIdentityIp).toBeLessThan(AUTH_RATE_LIMITS.login.perIdentity);
        for (let i = 0; i < AUTH_RATE_LIMITS.login.perIdentityIp; i++) {
          expect((await post("/auth/user/emailpass", bad, { "x-forwarded-for": net(i) })).status).toBe(401);
        }
        expect429(
          await post(
            "/auth/user/emailpass",
            { email: admin.email, password: admin.password },
            { "x-forwarded-for": net(99) },
          ),
        );
        // Ngoài /64 đó (chưa tới ngưỡng theo email) vẫn đăng nhập đúng được.
        expect(
          (
            await post(
              "/auth/user/emailpass",
              { email: admin.email, password: admin.password },
              { "x-forwarded-for": newV6Net()(0) },
            )
          ).status,
        ).toBe(200);
      });

      it("đăng ký: XFF xoay trong /64 → 429 ở `register.perIp`; IPv4 không đổi — IP liền kề không chung bộ đếm", async () => {
        const net = newV6Net();
        const n = AUTH_RATE_LIMITS.register.perIp;
        for (let i = 0; i < n; i++) {
          const r = await post(
            "/auth/user/emailpass/register",
            { email: unknownEmail(), password },
            { "x-forwarded-for": net(i) },
          );
          expect({ i, status: r.status }).toEqual({ i, status: 400 });
        }
        expect429(
          await post(
            "/auth/user/emailpass/register",
            { email: unknownEmail(), password },
            { "x-forwarded-for": net(n) },
          ),
        );

        const v4 = newIp();
        const neighbour = newIp();
        for (let i = 0; i < n; i++) {
          await post(
            "/auth/user/emailpass/register",
            { email: unknownEmail(), password },
            { "x-forwarded-for": v4 },
          );
        }
        expect429(
          await post(
            "/auth/user/emailpass/register",
            { email: unknownEmail(), password },
            { "x-forwarded-for": v4 },
          ),
        );
        expect(
          (
            await post(
              "/auth/user/emailpass/register",
              { email: unknownEmail(), password },
              { "x-forwarded-for": neighbour },
            )
          ).status,
        ).toBe(400);
      });

      it("GET/HEAD đăng nhập emailpass có thân → 405, không token; không làm lệch bộ đếm; provider khác không bị 405", async () => {
        const admin = await createAdmin(api as never, container);
        const ip = newIp();
        const h = { "x-forwarded-for": ip };
        for (let i = 0; i < 30; i++) {
          const r = await send(
            "GET",
            "/auth/user/emailpass",
            { email: admin.email, password: "sai-mat-khau-0123" },
            h,
          );
          expect(r.status).toBe(405);
        }
        for (const path of ["/auth/user/emailpass", "/auth/%75ser/emailpass", "/auth/customer/emailpass"]) {
          const good = await send("GET", path, { email: admin.email, password: admin.password }, h);
          expect({ path, status: good.status }).toEqual({ path, status: 405 });
          expect(good.headers.allow).toBe("POST");
          expect(good.json.token).toBeUndefined();
          expect(JSON.stringify(good.json)).not.toMatch(/eyJ/);
          const head = await send("HEAD", path, { email: admin.email, password: admin.password }, h);
          expect({ path, status: head.status }).toEqual({ path, status: 405 });
        }
        // Provider không phải emailpass không bị cổng 405 chặn (OAuth dùng GET cho bước chuyển hướng).
        expect((await send("GET", "/auth/user/google", {}, h)).status).not.toBe(405);
        // 30 lần GET không vào bộ đếm thất bại: POST đúng mật khẩu cùng IP vẫn 200.
        expect(
          (await post("/auth/user/emailpass", { email: admin.email, password: admin.password }, h)).status,
        ).toBe(200);
      });
    });
  },
});
