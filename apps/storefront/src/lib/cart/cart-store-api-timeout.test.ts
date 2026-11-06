// @vitest-environment node
import { resetEnvCacheForTests } from "../env";
import { StoreApiError, storeApi } from "./medusa";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test";
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCacheForTests();
});

/** fetch giả treo tới khi signal huỷ (như fetch thật khi hết hạn). */
function hangingFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

describe("cart storeApi: timeout và retry (FE-STATE-005, XC-PERF-006)", () => {
  it("server treo: POST giỏ hết hạn sau 8 s → StoreApiError NETWORK, chỉ gọi 1 lần, có signal", async () => {
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    const p = storeApi("/store/carts/c1/line-items", { method: "POST", body: { variant_id: "v" } });
    const assertion = expect(p).rejects.toMatchObject({ name: "StoreApiError", status: 0, code: "NETWORK" });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("POST/DELETE giỏ gặp 503 hoặc lỗi mạng: KHÔNG retry (tránh thêm dòng hai lần)", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      const f = vi.fn(async () => new Response("{}", { status: 503 }));
      vi.stubGlobal("fetch", f);
      await expect(storeApi("/store/carts/c1/line-items", { method })).rejects.toBeInstanceOf(StoreApiError);
      expect(f).toHaveBeenCalledTimes(1);
    }
    const net = vi.fn(async () => {
      throw new TypeError("down");
    });
    vi.stubGlobal("fetch", net);
    await expect(storeApi("/store/carts", { method: "POST", body: {} })).rejects.toMatchObject({
      code: "NETWORK",
    });
    expect(net).toHaveBeenCalledTimes(1);
  });

  it("POST có Idempotency-Key (checkout submit) được retry lỗi tạm thời", async () => {
    const f = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const p = storeApi("/store/x/checkout/submit", {
      method: "POST",
      body: {},
      headers: { "Idempotency-Key": "k".repeat(20) },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).data).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("GET giỏ retry lỗi tạm thời đúng 1 lần; 404 không retry", async () => {
    const f = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cart: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const p = storeApi("/store/carts/c1");
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).data).toEqual({ cart: 1 });
    expect(f).toHaveBeenCalledTimes(2);

    const nf = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", nf);
    await expect(storeApi("/store/carts/zz")).rejects.toMatchObject({ status: 404 });
    expect(nf).toHaveBeenCalledTimes(1);
  });

  it("GET treo: hạn tổng 10 s cho cả chuỗi (lần 1 hết 8 s, lần 2 bị cắt ở 10 s) rồi báo NETWORK", async () => {
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    let settled = false;
    const assertion = expect(
      storeApi("/store/carts/c1").finally(() => (settled = true)),
    ).rejects.toMatchObject({
      code: "NETWORK",
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(f.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
