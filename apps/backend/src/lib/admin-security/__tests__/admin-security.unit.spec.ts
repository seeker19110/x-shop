import { ADMIN_X_PERMISSIONS } from "../../../api/admin/x/permissions";
import { requirePermission } from "../../access/require-permission";
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
    // T-044: route native ghi tiền / hủy đơn đóng với mọi vai trò (kể cả owner) — đi qua /admin/x/*.
    for (const path of [
      "/admin/payments/p/refund",
      "/admin/payments/p/capture",
      "/admin/payments/p",
      "/admin/payment-collections/pc/mark-as-paid",
      "/admin/payment-collections",
      "/admin/orders/o/credit-lines",
    ]) {
      expect(resolveAdminRule("POST", path)).toEqual({ kind: "deny", reason: "NATIVE_MONEY_ROUTE" });
    }
    expect(resolveAdminRule("DELETE", "/admin/payment-collections/pc")).toMatchObject({ kind: "deny" });
    expect(resolveAdminRule("POST", "/admin/orders/o/cancel")).toEqual({
      kind: "deny",
      reason: "NATIVE_ORDER_CANCEL",
    });
    expect(resolveAdminRule("GET", "/admin/payments/p")).toMatchObject({ permission: "payment.read" });
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
      expect((await registerAttempt(store, "login", "a@example.test", "1.1.1.1")).allowed).toBe(true);
    }
    const blocked = await registerAttempt(store, "login", "A@example.test ", "1.1.1.1");
    expect(blocked).toMatchObject({ allowed: false });
    expect((blocked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((await registerAttempt(store, "login", "a@example.test", "2.2.2.2")).allowed).toBe(true);
    expect((await registerAttempt(store, "login", "b@example.test", "1.1.1.1")).allowed).toBe(true);
  });

  it("đoán phân tán vào một email từ nhiều IP → chặn theo email", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIdentity; i++)
      await registerAttempt(store, "login", "v@example.test", `10.0.0.${i}`);
    expect((await registerAttempt(store, "login", "v@example.test", "10.0.1.1")).allowed).toBe(false);
  });

  it("không khoá cả mạng: một IP dùng chung với nhiều tài khoản chỉ bị chặn ở ngưỡng IP cao", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIp; i++) {
      expect((await registerAttempt(store, "login", `u${i}@example.test`, "9.9.9.9")).allowed).toBe(true);
    }
    expect((await registerAttempt(store, "login", "moi@example.test", "9.9.9.9")).allowed).toBe(false);
  });

  it("thành công không tính thất bại; lỗi 5xx được hoàn lại", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIdentityIp * 3; i++) {
      expect((await registerAttempt(store, "login", "ok@example.test", "3.3.3.3")).allowed).toBe(true);
      await registerSuccess(store, "login", "ok@example.test", "3.3.3.3");
    }
    for (let i = 0; i < L.perIdentityIp * 3; i++) {
      expect((await registerAttempt(store, "login", "err@example.test", "4.4.4.4")).allowed).toBe(true);
      await registerRefund(store, "login", "err@example.test", "4.4.4.4");
    }
  });

  it("IPv6 gộp /64 (T-148): xoay địa chỉ trong một /64 vẫn chung bộ đếm IP và (email+IP); /64 khác tách riêng", async () => {
    const store = new MemoryStore();
    const in64 = (i: number) => `2001:db8:a:b:${(i + 1).toString(16)}::${(i * 7 + 3).toString(16)}`;
    for (let i = 0; i < L.perIp; i++) {
      expect((await registerAttempt(store, "login", `x${i}@example.test`, in64(i))).allowed).toBe(true);
    }
    // Dạng viết đầy đủ (số 0 đầu, chữ hoa) của cùng /64 vẫn chung bộ đếm.
    expect(
      (await registerAttempt(store, "login", "moi@example.test", "2001:0DB8:000A:000B:ffff:1:2:3")).allowed,
    ).toBe(false);
    expect((await registerAttempt(store, "login", "moi2@example.test", "2001:db8:a:c::1")).allowed).toBe(
      true,
    );

    for (let i = 0; i < L.perIdentityIp; i++) {
      expect(
        (await registerAttempt(store, "login", "v6@example.test", `2001:db8:1:2::${i + 1}`)).allowed,
      ).toBe(true);
    }
    expect((await registerAttempt(store, "login", "v6@example.test", "2001:db8:1:2:9::9")).allowed).toBe(
      false,
    );
    // Thành công từ một địa chỉ trong /64 xoá thất bại (email+IP) của cả /64 (cùng khoá).
    await registerSuccess(store, "login", "v6@example.test", "2001:db8:1:2::77");
    for (let i = 0; i < L.perIdentityIp; i++) {
      expect(
        (await registerAttempt(store, "login", "v6@example.test", `2001:db8:1:2:a::${i + 1}`)).allowed,
      ).toBe(true);
    }
    expect((await registerAttempt(store, "login", "v6@example.test", "2001:db8:1:2:b::1")).allowed).toBe(
      false,
    );
  });

  it("kẹp bộ đếm (T-143, D-085): loạt 200 lần không kéo dài Retry-After so với khoá tối thiểu (limit + 1 lần)", async () => {
    const M = AUTH_RATE_LIMITS.windowSeconds * 1000;
    // Đầu cửa sổ cố định — trường hợp Retry-After dài nhất của xấp xỉ cửa sổ trượt.
    const now = new Date(Math.floor(Date.now() / M) * M);
    const lockout = async (n: number) => {
      const store = new MemoryStore();
      let last: Awaited<ReturnType<typeof registerAttempt>> = { allowed: true };
      for (let i = 0; i < n; i++)
        last = await registerAttempt(store, "reset", "k@example.test", "1.2.3.4", now);
      expect(last.allowed).toBe(false);
      return (last as { retryAfterSeconds: number }).retryAfterSeconds;
    };
    const L3 = AUTH_RATE_LIMITS.reset.perIdentityIp;
    const minimal = await lockout(L3 + 1);
    expect(await lockout(200)).toBe(minimal);
    // Trần lý thuyết với bộ đếm kẹp ở L+1: hết cửa sổ hiện tại + 2/(L+1) cửa sổ sau.
    expect(minimal).toBeLessThanOrEqual(Math.ceil((AUTH_RATE_LIMITS.windowSeconds * (L3 + 3)) / (L3 + 1)));
  });

  it("D-085: IP A đã bị chặn không đốt hạn mức theo email của nạn nhân — nạn nhân ở IP B vẫn được thử", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        registerAttempt(
          store,
          "login",
          i % 2 ? "VICTIM@example.test" : " victim@example.test ",
          "203.0.113.9",
        ),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(L.perIdentityIp);
    expect((await registerAttempt(store, "login", "victim@example.test", "203.0.113.10")).allowed).toBe(true);
  });

  it("IPv4 giữ nguyên địa chỉ (T-148): hai IP liền kề không chung bộ đếm IP", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L.perIp; i++)
      await registerAttempt(store, "login", `y${i}@example.test`, "198.51.100.7");
    expect((await registerAttempt(store, "login", "z@example.test", "198.51.100.7")).allowed).toBe(false);
    expect((await registerAttempt(store, "login", "z@example.test", "198.51.100.8")).allowed).toBe(true);
  });

  it("đồng thời: loạt thử song song không vượt ngưỡng (giữ chỗ trước bằng INCR)", async () => {
    const store = new MemoryStore();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => registerAttempt(store, "mfa", "ai_1", "5.5.5.5")),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(AUTH_RATE_LIMITS.mfa.perIdentityIp);
  });
});

describe("requirePermission (lớp thứ hai trong route)", () => {
  const req = (access?: { userId: string; roles: string[] }) => ({ x_admin_access: access }) as never;

  it("guard chưa chạy → 401; thiếu một trong các quyền → 403; đủ → trả actor id", () => {
    expect(() => requirePermission(req(), "catalog.import")).toThrow(
      expect.objectContaining({ type: "unauthorized" }),
    );
    const cm = req({ userId: "u1", roles: ["catalog_manager"] });
    expect(requirePermission(cm, "catalog.import", "price.write")).toBe("u1");
    expect(() => requirePermission(cm, "catalog.import", "price.write", "inventory.adjust")).toThrow(
      /inventory\.adjust/,
    );
    const both = req({ userId: "u2", roles: ["catalog_manager", "warehouse"] });
    expect(requirePermission(both, "catalog.import", "price.write", "inventory.adjust")).toBe("u2");
  });
});
