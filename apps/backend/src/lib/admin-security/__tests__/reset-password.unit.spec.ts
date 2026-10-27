import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { AUTH_RATE_LIMITS } from "../config";
import {
  processResetRequest,
  RESET_RESPONSE_MS,
  RESET_WORK_MAX_DELAY_MS,
  resetIdentity,
  resetPasswordGuard,
  resetWorkDelayMs,
} from "../reset-password";
import { MemoryStore } from "../store";

// Unit không có env đầy đủ (DATABASE_URL…) → IP khách lấy từ header test; phần còn lại của module giữ nguyên.
jest.mock("../../security/config", () => ({
  ...jest.requireActual<Record<string, unknown>>("../../security/config"),
  clientIpOf: (req: { headers: Record<string, string | undefined> }) => ({
    ip: req.headers["x-test-ip"] ?? "192.0.2.10",
    internal: false,
  }),
}));
const workflowRun = jest.fn(async () => ({ result: "jwt", errors: [] }));
jest.mock("@medusajs/medusa/core-flows", () => ({
  generateResetPasswordTokenWorkflow: () => ({ run: workflowRun }),
}));
let draining = false;
jest.mock("../../lifecycle/shutdown", () => ({ isDraining: () => draining }));
const mockDelay = jest.fn((_min: number, _max: number) => 4000);
jest.mock("node:crypto", () => ({
  ...jest.requireActual<Record<string, unknown>>("node:crypto"),
  randomInt: (min: number, max: number) => mockDelay(min, max),
}));

/**
 * T-143 (D-085, D-086): nhánh biên của middleware đặt lại mật khẩu (luồng đầy đủ + đo thời gian ở
 * integration-tests/http/security-register.spec.ts).
 */
const KNOWN = "co@x.test";
function fakeScope() {
  const store = new MemoryStore();
  const listProviderIdentities = jest.fn(async (filter: { entity_id: string }) =>
    filter.entity_id === KNOWN ? [{ id: "pi_1" }] : [],
  );
  const warn = jest.fn();
  const scope = {
    resolve: (key: string) => {
      if (key === Modules.AUTH) return { listProviderIdentities };
      if (key === ContainerRegistrationKeys.CONFIG_MODULE)
        return { projectConfig: { http: { jwtSecret: "s" } } };
      if (key === ContainerRegistrationKeys.LOGGER) return { warn };
      return { securityStore: () => store };
    },
  };
  return { scope, store, listProviderIdentities, warn };
}

function fakeReq(
  scope: ReturnType<typeof fakeScope>["scope"],
  opts: { body?: unknown; validatedBody?: unknown; ip?: string },
) {
  return {
    scope,
    headers: { "x-test-ip": opts.ip },
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
    send(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return { res: res as unknown as MedusaResponse, state };
}

/** Chạy middleware dưới đồng hồ giả: tua qua thời gian phản hồi cố định. */
async function run(req: MedusaRequest) {
  const { res, state } = fakeRes();
  const p = resetPasswordGuard(req, res);
  await jest.advanceTimersByTimeAsync(RESET_RESPONSE_MS);
  await p;
  return state;
}

beforeEach(() => {
  jest.useFakeTimers();
  workflowRun.mockClear();
  mockDelay.mockClear();
  draining = false;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("resetIdentity / resetWorkDelayMs", () => {
  it("identifier từ thân đã validate, rồi thân thô; không phải chuỗi → null; cắt 320 ký tự", () => {
    const { scope } = fakeScope();
    expect(resetIdentity(fakeReq(scope, { validatedBody: { identifier: "a@x.test" } }))).toBe("a@x.test");
    expect(resetIdentity(fakeReq(scope, { body: { identifier: "b@x.test" } }))).toBe("b@x.test");
    expect(resetIdentity(fakeReq(scope, { body: { identifier: 42 } }))).toBeNull();
    expect(resetIdentity(fakeReq(scope, { body: undefined }))).toBeNull();
    expect(resetIdentity(fakeReq(scope, { body: { identifier: "x".repeat(400) } }))).toHaveLength(320);
  });

  it("độ trễ việc nền lấy đều trong [0, 5000] ms (randomInt CSPRNG, cận trên loại trừ = 5001)", () => {
    expect(resetWorkDelayMs()).toBe(4000);
    expect(mockDelay).toHaveBeenCalledWith(0, RESET_WORK_MAX_DELAY_MS + 1);
  });
});

describe("resetPasswordGuard", () => {
  it("được phép: 201 sau đúng thời gian cố định; việc nền chỉ bắt đầu sau độ trễ ngẫu nhiên; metadata bị bỏ", async () => {
    const f = fakeScope();
    const { res, state } = fakeRes();
    const p = resetPasswordGuard(
      fakeReq(f.scope, { validatedBody: { identifier: KNOWN, metadata: { big: "x".repeat(1000) } } }),
      res,
    );
    await jest.advanceTimersByTimeAsync(RESET_RESPONSE_MS - 1);
    expect(state.status).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(state.status).toBe(201);
    expect(f.listProviderIdentities).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(4000 - RESET_RESPONSE_MS - 1);
    expect(f.listProviderIdentities).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.listProviderIdentities).toHaveBeenCalledTimes(1);
    expect(workflowRun).toHaveBeenCalledTimes(1);
    expect(workflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ entityId: KNOWN, metadata: {} }),
        throwOnError: false,
      }),
    );
  });

  it("tiến trình đang tắt khi tới giờ chạy việc nền → bỏ, không tra identity/không workflow", async () => {
    const f = fakeScope();
    expect((await run(fakeReq(f.scope, { validatedBody: { identifier: KNOWN } }))).status).toBe(201);
    draining = true;
    await jest.advanceTimersByTimeAsync(RESET_WORK_MAX_DELAY_MS);
    expect(f.listProviderIdentities).not.toHaveBeenCalled();
    expect(workflowRun).not.toHaveBeenCalled();
  });

  it("bị từ chối: thiếu thân đã validate → 400 chung (không nhường handler gốc), vẫn tính lượt → 429", async () => {
    const f = fakeScope();
    for (let i = 0; i < AUTH_RATE_LIMITS.reset.perIdentityIp; i++) {
      const s = await run(fakeReq(f.scope, { body: { identifier: "c@x.test" } }));
      expect(s.status).toBe(400);
      expect(String(s.body)).toContain("INVALID_REQUEST");
    }
    const s = await run(fakeReq(f.scope, { body: { identifier: " C@X.test " } }));
    expect(s.status).toBe(429);
    expect(Number(s.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    await jest.advanceTimersByTimeAsync(RESET_WORK_MAX_DELAY_MS);
    expect(f.listProviderIdentities).not.toHaveBeenCalled();
  });

  it("D-085: biến thể email nạn nhân từ IP A bị 429 nhưng KHÔNG khoá nạn nhân ở IP B (không có ngưỡng email trên request)", async () => {
    const f = fakeScope();
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const variant = i % 2 === 0 ? KNOWN.toUpperCase() : ` ${KNOWN} `;
      statuses.push(
        (await run(fakeReq(f.scope, { validatedBody: { identifier: variant }, ip: "198.51.100.1" }))).status,
      );
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(AUTH_RATE_LIMITS.reset.perIdentityIp);
    const victim = await run(fakeReq(f.scope, { validatedBody: { identifier: KNOWN }, ip: "198.51.100.2" }));
    expect(victim.status).toBe(201);
  });

  it("đồng thời: loạt song song cùng email + IP chỉ đúng `perIdentityIp` lượt 201, phần còn lại 429", async () => {
    const f = fakeScope();
    const pending = Array.from({ length: 10 }, () => {
      const { res, state } = fakeRes();
      return resetPasswordGuard(fakeReq(f.scope, { validatedBody: { identifier: "d@x.test" } }), res).then(
        () => state.status,
      );
    });
    await jest.advanceTimersByTimeAsync(RESET_RESPONSE_MS);
    const statuses = await Promise.all(pending);
    expect(statuses.filter((s) => s === 201)).toHaveLength(AUTH_RATE_LIMITS.reset.perIdentityIp);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 429)).toBe(true);
  });
});

describe("processResetRequest (việc nền)", () => {
  it("email lạ → không workflow; email có thật → workflow; quá `perIdentity` → bỏ âm thầm", async () => {
    const f = fakeScope();
    const input = { identifier: "la@x.test", actorType: "user", provider: "emailpass" };
    expect(await processResetRequest(f.scope as never, f.store, input)).toBe("no_identity");
    expect(workflowRun).not.toHaveBeenCalled();
    for (let i = 0; i < AUTH_RATE_LIMITS.reset.perIdentity; i++) {
      expect(await processResetRequest(f.scope as never, f.store, { ...input, identifier: KNOWN })).toBe(
        "issued",
      );
    }
    expect(await processResetRequest(f.scope as never, f.store, { ...input, identifier: KNOWN })).toBe(
      "identity_limited",
    );
    expect(workflowRun).toHaveBeenCalledTimes(AUTH_RATE_LIMITS.reset.perIdentity);
  });
});
