import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { AUTH_RATE_LIMITS } from "../config";
import { resetIdentity, resetPasswordGuard } from "../reset-password";
import { MemoryStore } from "../store";

// Unit không có env đầy đủ (DATABASE_URL…) → IP khách cố định; phần còn lại của module giữ nguyên.
jest.mock("../../security/config", () => ({
  ...jest.requireActual<Record<string, unknown>>("../../security/config"),
  clientIpOf: () => ({ ip: "192.0.2.10", internal: false }),
}));

/**
 * T-143: nhánh biên của middleware đặt lại mật khẩu (luồng đầy đủ + đo thời gian ở
 * integration-tests/http/security-register.spec.ts).
 */
function fakeReq(store: MemoryStore, opts: { body?: unknown; validatedBody?: unknown }) {
  return {
    scope: { resolve: () => ({ securityStore: () => store }) },
    headers: {},
    params: { actor_type: "user", auth_provider: "emailpass" },
    body: opts.body,
    validatedBody: opts.validatedBody,
  } as unknown as MedusaRequest;
}

function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    sendStatus(code: number) {
      state.status = code;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
    type() {
      return res;
    },
    send(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return { res: res as unknown as MedusaResponse, state };
}

describe("resetIdentity", () => {
  it("lấy identifier từ thân đã validate, rồi thân thô; không phải chuỗi → null; cắt 320 ký tự", () => {
    const store = new MemoryStore();
    expect(resetIdentity(fakeReq(store, { validatedBody: { identifier: "a@x.test" } }))).toBe("a@x.test");
    expect(resetIdentity(fakeReq(store, { body: { identifier: "b@x.test" } }))).toBe("b@x.test");
    expect(resetIdentity(fakeReq(store, { body: { identifier: 42 } }))).toBeNull();
    expect(resetIdentity(fakeReq(store, { body: undefined }))).toBeNull();
    expect(resetIdentity(fakeReq(store, { body: { identifier: "x".repeat(400) } }))).toHaveLength(320);
  });
});

describe("resetPasswordGuard — nhánh biên", () => {
  it("thiếu thân đã validate (validator gốc không chạy trước) → nhường route gốc nhưng vẫn tính lượt", async () => {
    const store = new MemoryStore();
    const n = AUTH_RATE_LIMITS.reset.perIdentityIp;
    for (let i = 0; i < n; i++) {
      const next = jest.fn();
      const { res, state } = fakeRes();
      await resetPasswordGuard(fakeReq(store, { body: { identifier: "c@x.test" } }), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBe(0);
    }
    const next = jest.fn();
    const { res, state } = fakeRes();
    await resetPasswordGuard(fakeReq(store, { body: { identifier: " C@X.test " } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(429);
    expect(Number(state.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("đồng thời: loạt song song cùng email + IP chỉ đúng `perIdentityIp` lượt qua, phần còn lại 429", async () => {
    const store = new MemoryStore();
    const runs = Array.from({ length: 10 }, async () => {
      const next = jest.fn();
      const { res, state } = fakeRes();
      await resetPasswordGuard(fakeReq(store, { body: { identifier: "d@x.test" } }), res, next);
      return { passed: next.mock.calls.length === 1, status: state.status };
    });
    const results = await Promise.all(runs);
    expect(results.filter((r) => r.passed)).toHaveLength(AUTH_RATE_LIMITS.reset.perIdentityIp);
    expect(results.filter((r) => !r.passed).every((r) => r.status === 429)).toBe(true);
  });
});
