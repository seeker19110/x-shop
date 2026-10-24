import { ADMIN_X_PERMISSIONS } from "../../../api/admin/x/permissions";
import { AUTH_RATE_LIMITS } from "../config";
import { resolveAdminRule } from "../policy";
import { registerAttempt, registerRefund, registerSuccess } from "../rate-limit";
import { matchPath, normalizeAdminPath, normalizeMethod } from "../route-match";
import { checkAndTouchSession, evaluateMfa, evaluateSession, sessionAnchorMs, sessionKey } from "../session";
import { MemoryStore } from "../store";

const policy = { maxAgeSeconds: 8 * 3600, idleSeconds: 30 * 60, reauthMaxAgeSeconds: 300 };
const T0 = Date.UTC(2026, 9, 24, 8, 0, 0);
const MIN = 60_000;

describe("route-match", () => {
  it("chuẩn hoá giống Express: hoa thường, '/' cuối, '//' , bỏ query", () => {
    expect(normalizeAdminPath("/ADMIN/X/Refunds/?a=1")).toBe("/admin/x/refunds");
    expect(normalizeAdminPath("/admin//x///audit")).toBe("/admin/x/audit");
    expect(normalizeAdminPath("/")).toBe("/");
    expect(normalizeMethod("head")).toBe("GET");
    expect(normalizeMethod("post")).toBe("POST");
  });

  it(":param khớp đúng một đoạn; '*' cuối khớp 0..n đoạn", () => {
    expect(matchPath("/admin/x/users/:id/roles", "/admin/x/users/u1/roles")).toBe(true);
    expect(matchPath("/admin/x/users/:id/roles", "/admin/x/users/roles")).toBe(false);
    expect(matchPath("/admin/x/users/:id/roles", "/admin/x/users/u1/roles/x")).toBe(false);
    expect(matchPath("/admin/products/*", "/admin/products")).toBe(true);
    expect(matchPath("/admin/products/*", "/admin/products/p1/variants")).toBe(true);
    expect(matchPath("/admin/products/*", "/admin/product-tags")).toBe(false);
  });
});

describe("resolveAdminRule", () => {
  it("/admin/x: theo map; không khai báo → deny (fail-closed)", () => {
    for (const r of ADMIN_X_PERMISSIONS) {
      const concrete = r.path.replace(/:\w+/g, "abc");
      expect(resolveAdminRule(r.method, concrete)).toMatchObject({
        kind: "permission",
        permission: r.permission,
      });
    }
    expect(resolveAdminRule("GET", "/admin/x/khong-co")).toEqual({
      kind: "deny",
      reason: "UNDECLARED_ROUTE",
    });
    expect(resolveAdminRule("PUT", "/admin/x/size-charts")).toMatchObject({ kind: "deny" });
    expect(resolveAdminRule("GET", "/admin/x")).toMatchObject({ kind: "deny" });
    expect(resolveAdminRule("POST", "/admin/x/users/u/roles")).toMatchObject({ reauth: true });
  });

  it("native: bảng nhạy cảm; đọc chưa khai → any_role; ghi chưa khai → settings.manage", () => {
    expect(resolveAdminRule("POST", "/admin/payments/p/refund")).toMatchObject({
      permission: "refund.execute",
    });
    expect(resolveAdminRule("POST", "/admin/orders/o/cancel")).toMatchObject({ permission: "order.cancel" });
    expect(resolveAdminRule("POST", "/admin/orders/o/fulfillments/f/shipments")).toMatchObject({
      permission: "fulfillment.update",
    });
    expect(resolveAdminRule("GET", "/admin/users/me")).toEqual({ kind: "self" });
    expect(resolveAdminRule("POST", "/admin/users/me")).toMatchObject({ permission: "user.manage" });
    expect(resolveAdminRule("POST", "/admin/invites/accept")).toEqual({ kind: "public" });
    expect(resolveAdminRule("GET", "/admin/invites/accept")).toMatchObject({ permission: "user.manage" });
    expect(resolveAdminRule("POST", "/admin/products/import")).toMatchObject({
      permission: "catalog.import",
    });
    expect(resolveAdminRule("POST", "/admin/products/p1")).toMatchObject({ permission: "catalog.write" });
    expect(resolveAdminRule("GET", "/admin/regions")).toEqual({ kind: "any_role" });
    expect(resolveAdminRule("DELETE", "/admin/regions/r")).toMatchObject({ permission: "settings.manage" });
    expect(resolveAdminRule("POST", "/admin/route-moi-trong-tuong-lai")).toMatchObject({
      permission: "settings.manage",
    });
  });
});

describe("chính sách phiên", () => {
  const at = (ms: number) => ({ anchorMs: T0, lastSeenMs: null, nowMs: ms, policy });

  it("tuyệt đối 8 giờ, nhàn rỗi 30 phút (biên đúng mốc vẫn hợp lệ)", () => {
    expect(evaluateSession(at(T0 + 30 * MIN))).toEqual({ ok: true });
    expect(evaluateSession(at(T0 + 30 * MIN + 1))).toEqual({ ok: false, code: "SESSION_IDLE" });
    expect(evaluateSession({ ...at(T0 + 8 * 60 * MIN), lastSeenMs: T0 + 8 * 60 * MIN - MIN })).toEqual({
      ok: true,
    });
    expect(evaluateSession({ ...at(T0 + 8 * 60 * MIN + 1), lastSeenMs: T0 + 8 * 60 * MIN })).toEqual({
      ok: false,
      code: "SESSION_EXPIRED",
    });
    expect(evaluateSession({ ...at(T0), anchorMs: null })).toEqual({ ok: false, code: "SESSION_EXPIRED" });
  });

  it("mốc = mfa_challenge_completed_at (giữ qua refresh), không có MFA → iat; dữ liệu hỏng → null", () => {
    const iat = Math.floor(T0 / 1000);
    expect(sessionAnchorMs({ iat })).toBe(iat * 1000);
    expect(sessionAnchorMs({ iat: iat + 999, mfa_challenge_completed_at: new Date(T0).toISOString() })).toBe(
      T0,
    );
    expect(sessionAnchorMs({ mfa_challenge_completed_at: "rác" })).toBeNull();
    expect(sessionAnchorMs({})).toBeNull();
    // Khóa phiên giống nhau qua refresh (cùng identity + mốc), khác giữa hai lần đăng nhập.
    expect(sessionKey({ auth_identity_id: "a" }, T0)).toBe(sessionKey({ auth_identity_id: "a" }, T0));
    expect(sessionKey({ auth_identity_id: "a" }, T0)).not.toBe(sessionKey({ auth_identity_id: "a" }, T0 + 1));
  });

  it("checkAndTouchSession: hoạt động gia hạn nhàn rỗi; phiên đã nhàn rỗi không được đánh thức lại", async () => {
    const store = new MemoryStore();
    const ctx = { auth_identity_id: "ai_1", iat: Math.floor(T0 / 1000) };
    expect(await checkAndTouchSession(store, ctx, policy, T0 + 20 * MIN)).toEqual({ ok: true });
    expect(await checkAndTouchSession(store, ctx, policy, T0 + 45 * MIN)).toEqual({ ok: true });
    expect(await checkAndTouchSession(store, ctx, policy, T0 + 76 * MIN)).toEqual({
      ok: false,
      code: "SESSION_IDLE",
    });
    expect(await checkAndTouchSession(store, ctx, policy, T0 + 77 * MIN)).toEqual({
      ok: false,
      code: "SESSION_IDLE",
    });
  });

  it("MFA: chưa bật/chưa xác minh → MFA_REQUIRED; quá hạn xác thực lại → REAUTH_REQUIRED", () => {
    const done = new Date(T0).toISOString();
    expect(evaluateMfa({}, T0, null)).toEqual({ ok: false, code: "MFA_REQUIRED" });
    expect(evaluateMfa({ mfa_enabled: true }, T0, null)).toEqual({ ok: false, code: "MFA_REQUIRED" });
    expect(evaluateMfa({ mfa_enabled: false, mfa_challenge_completed_at: done }, T0, null)).toEqual({
      ok: false,
      code: "MFA_REQUIRED",
    });
    expect(
      evaluateMfa({ mfa_enabled: true, mfa_challenge_completed_at: done }, T0 + 8 * 60 * MIN, null),
    ).toEqual({
      ok: true,
    });
    expect(evaluateMfa({ mfa_enabled: true, mfa_challenge_completed_at: done }, T0 + 5 * MIN, 300)).toEqual({
      ok: true,
    });
    expect(
      evaluateMfa({ mfa_enabled: true, mfa_challenge_completed_at: done }, T0 + 5 * MIN + 1, 300),
    ).toEqual({
      ok: false,
      code: "REAUTH_REQUIRED",
    });
  });
});

describe("rate limit nhiều tín hiệu", () => {
  const L = AUTH_RATE_LIMITS.login;

  it("(email+IP) chặn sau ngưỡng; email đó từ IP khác và email khác cùng IP vẫn được thử", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIdentityIp; i++) {
      expect((await registerAttempt(store, "login", "a@x.vn", "1.1.1.1")).allowed).toBe(true);
    }
    const blocked = await registerAttempt(store, "login", "A@x.vn ", "1.1.1.1");
    expect(blocked).toMatchObject({ allowed: false });
    expect((blocked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((await registerAttempt(store, "login", "a@x.vn", "2.2.2.2")).allowed).toBe(true);
    expect((await registerAttempt(store, "login", "b@x.vn", "1.1.1.1")).allowed).toBe(true);
  });

  it("đoán phân tán vào một email từ nhiều IP → chặn theo email", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIdentity; i++) await registerAttempt(store, "login", "v@x.vn", `10.0.0.${i}`);
    expect((await registerAttempt(store, "login", "v@x.vn", "10.0.1.1")).allowed).toBe(false);
  });

  it("không khoá cả mạng: một IP dùng chung với nhiều tài khoản chỉ bị chặn ở ngưỡng IP cao", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIp; i++) {
      expect((await registerAttempt(store, "login", `u${i}@x.vn`, "9.9.9.9")).allowed).toBe(true);
    }
    expect((await registerAttempt(store, "login", "moi@x.vn", "9.9.9.9")).allowed).toBe(false);
  });

  it("thành công không tính thất bại; lỗi 5xx được hoàn lại", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIdentityIp * 3; i++) {
      expect((await registerAttempt(store, "login", "ok@x.vn", "3.3.3.3")).allowed).toBe(true);
      await registerSuccess(store, "login", "ok@x.vn", "3.3.3.3");
    }
    for (let i = 0; i < L.perIdentityIp * 3; i++) {
      expect((await registerAttempt(store, "login", "err@x.vn", "4.4.4.4")).allowed).toBe(true);
      await registerRefund(store, "login", "err@x.vn", "4.4.4.4");
    }
  });

  it("đồng thời: loạt thử song song không vượt ngưỡng (giữ chỗ trước bằng INCR)", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => registerAttempt(store, "mfa", "ai_1", "5.5.5.5")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(AUTH_RATE_LIMITS.mfa.perIdentityIp);
  });
});
