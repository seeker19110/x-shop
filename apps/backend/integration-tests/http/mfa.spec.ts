import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateJwtToken } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import { sessionAnchorMs, sessionKey } from "../../src/lib/admin-security/session";
import { KEY_PREFIX } from "../../src/lib/admin-security/store";
import {
  createAdmin,
  createMfaAdmin,
  enrollTotp,
  jwtPayload,
  loginWithMfa,
  noThrow,
  totp,
  type MfaAdmin,
} from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

const MIN = 60_000;

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let redis: Redis;

    beforeAll(async () => {
      container = getContainer();
      redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
      // Bộ đếm rate limit sống 15 phút trong Redis — xoá phần của lần chạy trước để test lặp lại được (cách ly test).
      const stale = await redis.keys(`${KEY_PREFIX}rl:*`);
      if (stale.length > 0) await redis.del(...stale);
    });
    afterAll(async () => {
      await redis.quit();
    });

    const call = (method: string, url: string, headers: Record<string, string>, data: unknown = {}) =>
      api.request({ method, url, headers, ...(method === "GET" ? {} : { data }), ...noThrow });

    /** Ký token admin bằng chính bí mật của server — mô phỏng thời gian trôi (mốc MFA/iat cũ) mà không chờ thật. */
    function forgeToken(base: MfaAdmin, claims: Record<string, unknown>) {
      const payload = jwtPayload(base.headers.authorization.slice("Bearer ".length));
      const { http } = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
      const { exp: _exp, ...rest } = payload;
      const token = generateJwtToken(
        { ...rest, ...claims },
        { secret: http.jwtSecret as string, expiresIn: "1d" },
      );
      return { authorization: `Bearer ${token}` };
    }

    const rolesUrl = (a: { userId: string }) => `/admin/x/users/${a.userId}/roles`;

    describe("MFA bắt buộc cho route nhạy cảm (S-402)", () => {
      it("chưa đăng ký MFA → 403 MFA_REQUIRED ở route nhạy cảm (custom + native); route thường vẫn dùng được", async () => {
        const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
        const res = await call("POST", rolesUrl(owner), owner.headers, { role: "support" });
        expect(res).toMatchObject({ status: 403, data: { code: "MFA_REQUIRED", permission: "user.manage" } });
        expect(res.headers["content-type"]).toContain("application/problem+json");
        expect((await call("GET", "/admin/users", owner.headers)).data.code).toBe("MFA_REQUIRED");
        expect((await call("POST", "/admin/x/refunds", owner.headers)).data.code).toBe("MFA_REQUIRED");
        expect((await call("GET", "/admin/x/size-charts", owner.headers)).status).toBe(200);
      });

      it("đăng ký TOTP (mã tính bằng thư viện chuẩn) → đăng nhập qua challenge → truy cập được", async () => {
        const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
        const { secret } = await enrollTotp(rawApi, owner.headers);
        // Token cũ (trước khi đăng ký, chưa qua challenge) vẫn bị từ chối.
        expect((await call("GET", "/admin/users", owner.headers)).data.code).toBe("MFA_REQUIRED");

        const first = await call(
          "POST",
          "/auth/user/emailpass",
          {},
          { email: owner.email, password: owner.password },
        );
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({ mfa_required: true });
        const actorless = { authorization: `Bearer ${String(first.data.token)}` };
        // Token trung gian (chưa qua MFA) không dùng được cho /admin.
        expect((await call("GET", "/admin/x/size-charts", actorless)).status).toBe(401);

        const challengeId = (first.data.mfa_challenge as { id: string }).id;
        const ok = await call("POST", `/auth/mfa/challenges/${challengeId}/verify`, actorless, {
          method: "totp",
          code: totp(secret),
        });
        expect(ok.status).toBe(200);
        const headers = { authorization: `Bearer ${String(ok.data.token)}` };
        expect(jwtPayload(String(ok.data.token))).toMatchObject({
          mfa_enabled: true,
          actor_id: owner.userId,
        });

        expect((await call("GET", "/admin/users", headers)).status).toBe(200);
        expect((await call("POST", rolesUrl(owner), headers, { role: "support" })).status).toBe(201);
      });

      it("mã sai → từ chối + đếm rate limit; quá ngưỡng → 429 kể cả mã đúng; định danh khác cùng IP không bị chặn", async () => {
        const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
        const { secret } = await enrollTotp(rawApi, owner.headers);
        const first = await call(
          "POST",
          "/auth/user/emailpass",
          {},
          { email: owner.email, password: owner.password },
        );
        const actorless = { authorization: `Bearer ${String(first.data.token)}` };
        const url = `/auth/mfa/challenges/${(first.data.mfa_challenge as { id: string }).id}/verify`;
        const wrong = totp(secret, Date.now() + 10 * MIN);

        for (let i = 0; i < AUTH_RATE_LIMITS.mfa.perIdentityIp; i++) {
          const res = await call("POST", url, actorless, { method: "totp", code: wrong });
          expect(res.status).toBeGreaterThanOrEqual(400);
          expect(res.status).toBeLessThan(500);
          expect(res.status).not.toBe(429);
        }
        const limited = await call("POST", url, actorless, { method: "totp", code: totp(secret) });
        expect(limited).toMatchObject({ status: 429, data: { code: "RATE_LIMITED" } });
        expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

        // Người khác sau cùng IP (NAT văn phòng) vẫn đăng nhập MFA được.
        const other = await createMfaAdmin(rawApi, container, { roles: ["support"] });
        expect(jwtPayload(other.headers.authorization.slice(7)).mfa_challenge_completed_at).toBeTruthy();
      });

      it("đăng nhập: sai mật khẩu quá ngưỡng (email + IP) → 429; email khác cùng IP vẫn đăng nhập được", async () => {
        const victim = await createAdmin(rawApi, container, { roles: ["support"] });
        for (let i = 0; i < AUTH_RATE_LIMITS.login.perIdentityIp; i++) {
          const res = await call(
            "POST",
            "/auth/user/emailpass",
            {},
            { email: victim.email, password: "sai-mat-khau" },
          );
          expect(res.status).toBe(401);
        }
        const blocked = await call(
          "POST",
          "/auth/user/emailpass",
          {},
          { email: victim.email, password: victim.password },
        );
        expect(blocked).toMatchObject({ status: 429, data: { code: "RATE_LIMITED" } });
        const bystander = await createAdmin(rawApi, container, { roles: ["support"] });
        const ok = await call(
          "POST",
          "/auth/user/emailpass",
          {},
          { email: bystander.email, password: bystander.password },
        );
        expect(ok.status).toBe(200);
      });

      it("đồng thời: 15 lần đoán mã song song → tối đa đúng ngưỡng lần được xử lý, phần còn lại 429", async () => {
        const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
        const { secret } = await enrollTotp(rawApi, owner.headers);
        const first = await call(
          "POST",
          "/auth/user/emailpass",
          {},
          { email: owner.email, password: owner.password },
        );
        const actorless = { authorization: `Bearer ${String(first.data.token)}` };
        const url = `/auth/mfa/challenges/${(first.data.mfa_challenge as { id: string }).id}/verify`;
        const wrong = totp(secret, Date.now() + 10 * MIN);
        const results = await Promise.all(
          Array.from({ length: 15 }, () => call("POST", url, actorless, { method: "totp", code: wrong })),
        );
        const processed = results.filter((r) => r.status !== 429);
        expect(processed.length).toBe(AUTH_RATE_LIMITS.mfa.perIdentityIp);
      });

      it("recovery code native: đăng nhập được bằng mã khôi phục, mã đã dùng không dùng lại được", async () => {
        const admin = await createMfaAdmin(rawApi, container, { roles: ["accountant"] });
        const gen = await call("POST", "/auth/mfa/recovery-codes", admin.headers, { count: 2 });
        expect(gen.status).toBe(200);
        const codes = gen.data.recovery_codes as string[];
        expect(codes).toHaveLength(2);
        const headers = await loginWithMfa(rawApi, admin, {
          method: "recovery_code",
          code: codes[0] as string,
        });
        // Qua MFA + RBAC thì tới handler thật (T-027): body rỗng → 422 kiểm schema, không phải 401/403.
        expect((await call("POST", "/admin/x/refunds", headers)).status).toBe(422);
        await expect(
          loginWithMfa(rawApi, admin, { method: "recovery_code", code: codes[0] as string }),
        ).rejects.toThrow();
      });
    });

    describe("chính sách phiên", () => {
      it("nhàn rỗi quá 30 phút → 401 SESSION_IDLE (và không tự sống lại)", async () => {
        const admin = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        expect((await call("GET", "/admin/x/size-charts", admin.headers)).status).toBe(200);
        const ctx = jwtPayload(admin.headers.authorization.slice(7));
        const key = KEY_PREFIX + sessionKey(ctx.auth_identity_id as string, sessionAnchorMs(ctx) as number);
        expect(await redis.get(key)).not.toBeNull();
        await redis.set(key, String(Date.now() - 31 * MIN), "EX", 3600);

        const idle = await call("GET", "/admin/x/size-charts", admin.headers);
        expect(idle).toMatchObject({ status: 401, data: { code: "SESSION_IDLE" } });
        expect((await call("GET", "/admin/users/me", admin.headers)).status).toBe(401);
        expect((await call("POST", "/auth/token/refresh", admin.headers)).status).toBe(401);
      });

      it("quá hạn tuyệt đối 8 giờ kể từ khi xác thực → 401 SESSION_EXPIRED; refresh không kéo dài được", async () => {
        const admin = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const old = forgeToken(admin, {
          mfa_challenge_completed_at: new Date(Date.now() - 8 * 60 * MIN - MIN).toISOString(),
        });
        expect((await call("GET", "/admin/x/size-charts", old)).data.code).toBe("SESSION_EXPIRED");
        expect((await call("POST", "/auth/token/refresh", old)).status).toBe(401);
      });

      it("refresh token MFA giữ mốc xác thực; token admin không MFA không refresh được", async () => {
        const admin = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const refreshed = await call("POST", "/auth/token/refresh", admin.headers);
        expect(refreshed.status).toBe(200);
        const before = jwtPayload(admin.headers.authorization.slice(7));
        const after = jwtPayload(String(refreshed.data.token));
        expect(after.mfa_challenge_completed_at).toBe(before.mfa_challenge_completed_at);
        expect(
          (await call("GET", "/admin/users", { authorization: `Bearer ${String(refreshed.data.token)}` }))
            .status,
        ).toBe(200);

        const plain = await createAdmin(rawApi, container, { roles: ["support"] });
        const res = await call("POST", "/auth/token/refresh", plain.headers);
        expect(res).toMatchObject({ status: 401, data: { code: "SESSION_EXPIRED" } });
      });

      it("xác thực lại ≤ 5 phút cho đổi quyền: MFA 6 phút trước → 403 REAUTH_REQUIRED; route nhạy cảm thường vẫn được", async () => {
        const admin = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const stale = forgeToken(admin, {
          mfa_challenge_completed_at: new Date(Date.now() - 6 * MIN).toISOString(),
        });
        // Mốc phiên mới (khác token gốc) → chưa có lần thấy cuối; 6 phút < 30 phút nhàn rỗi.
        const res = await call("POST", rolesUrl(admin), stale, { role: "support" });
        expect(res).toMatchObject({ status: 403, data: { code: "REAUTH_REQUIRED", max_age_seconds: 300 } });
        expect((await call("GET", "/admin/users", stale)).status).toBe(200);
        // Xác thực lại (mật khẩu + TOTP) → làm được.
        const fresh = await loginWithMfa(rawApi, admin, { method: "totp", code: totp(admin.secret) });
        expect((await call("POST", rolesUrl(admin), fresh, { role: "support" })).status).toBe(201);
      });
    });
  },
});
