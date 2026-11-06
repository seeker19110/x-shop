import { listWards, validateAddress } from "@x-shop/domain";
import { GHN_RETRY_POLICY } from "../config";
import { classifyGhnError, GhnError, HttpGhnClient, MockModeGhnClient } from "../ghn-client";

/**
 * T-093 — BE-REL-003, BE-INT-007, ARC-RES-002: retry phía dịch vụ của adapter GHN (fetch giả, sleep/đồng hồ tiêm).
 * Thao tác idempotent retry lỗi tạm tối đa 3 lần; tạo/hủy chỉ retry 429 có Retry-After; tôn trọng Retry-After; không gửi
 * header idempotency mà GHN không công bố — khoá tự nhiên là client_order_code giống nhau ở mọi lần thử.
 */
const ward = listWards("01")[0]!;
const addr = validateAddress({ provinceCode: "01", wardCode: ward.code, line: "1 Tràng Tiền" });
if (!addr.ok) throw new Error("fixture");
const input = {
  clientOrderCode: "XS-ABCDEF-S1",
  to: { name: "Nguyễn Văn A", phone: "0912345678", address: addr.value },
  codAmount: 0,
  insuranceValue: 700_000,
  weightGrams: 300,
  items: [{ name: "Áo", code: "SKU1", quantity: 1, price: 700_000, weightGrams: 300 }],
  paymentTypeId: 1 as const,
  requiredNote: "CHOXEMHANGKHONGTHU" as const,
};
const cfg = {
  mode: "sandbox" as const,
  baseUrl: "https://ghn.test/api",
  token: "tok-12345678",
  shopId: "99",
};
const DETAIL = {
  code: 200,
  data: { order_code: "GHN1", client_order_code: "XS-1", status: "picking", cod_amount: 0 },
};
const CREATED = { code: 200, data: { order_code: "GHN9", total_fee: 22_000 } };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "timeout" | "network";

/** fetch giả trả lần lượt `replies` (phần tử cuối lặp lại); ghi lại mọi request. */
function scripted(replies: Reply[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const r = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    if (r === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    if (r === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  });
  return { fn: fn as unknown as typeof fetch, requests };
}

function client(timeoutMs = 10_000) {
  let t = 0;
  const sleeps: number[] = [];
  const c = new HttpGhnClient(cfg, timeoutMs, {
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    random: () => 0.5,
  });
  return { c, sleeps };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe("HttpGhnClient — retry thao tác idempotent (tra cứu, báo phí)", () => {
  it("503 hai lần rồi 200 → trả chi tiết sau đúng 3 lần gọi, chờ backoff có jitter giữa các lần", async () => {
    const s = scripted([{ status: 503 }, { status: 503 }, { status: 200, body: DETAIL }]);
    global.fetch = s.fn;
    const { c, sleeps } = client();
    expect(await c.detail("GHN1")).toMatchObject({ orderCode: "GHN1", status: "picking" });
    expect(s.requests).toHaveLength(3);
    // full jitter, random 0,5: 0,5·200 và 0,5·400.
    expect(sleeps).toEqual([100, 200]);
  });

  it("503 liên tục → đúng maxAttempts (3) lần rồi GhnError unavailable mang status", async () => {
    const s = scripted([{ status: 503 }]);
    global.fetch = s.fn;
    const { c } = client();
    await expect(c.detailByClientCode("XS-1")).rejects.toMatchObject({ kind: "unavailable", status: 503 });
    expect(s.requests).toHaveLength(GHN_RETRY_POLICY.maxAttempts);
  });

  it("lỗi mạng / 408 / timeout ngắn (trong ngân sách) → retry; báo phí cũng retry", async () => {
    for (const first of ["network", { status: 408 }] as Reply[]) {
      const s = scripted([first, { status: 200, body: { code: 200, data: { total: 30_000 } } }]);
      global.fetch = s.fn;
      const { c } = client();
      expect(await c.quoteFee({ to: addr.value, weightGrams: 300, insuranceValue: 0 })).toMatchObject({
        fee: 30_000,
      });
      expect(s.requests).toHaveLength(2);
    }
  });

  it("400/409/401/403 → không retry (1 lần gọi)", async () => {
    for (const status of [400, 409]) {
      const s = scripted([{ status, body: { code: status, message: "x" } }]);
      global.fetch = s.fn;
      expect(await client().c.detail("GHN1")).toBeNull();
      expect(s.requests).toHaveLength(1);
    }
    const s400 = scripted([{ status: 400, body: { code: 400, message: "x" } }]);
    global.fetch = s400.fn;
    await expect(
      client().c.quoteFee({ to: addr.value, weightGrams: 300, insuranceValue: 0 }),
    ).rejects.toMatchObject({ kind: "not_served" });
    expect(s400.requests).toHaveLength(1);
    for (const status of [401, 403]) {
      const s = scripted([{ status }]);
      global.fetch = s.fn;
      await expect(client().c.detail("GHN1")).rejects.toMatchObject({ kind: "unavailable", status });
      expect(s.requests).toHaveLength(1);
    }
  });

  it("timeout đã tiêu hết ngân sách (ngân sách ≤ một lần timeout) → không gọi thêm", async () => {
    // Đồng hồ thật: lần gọi treo tới timeout 50 ms → tổng ngân sách 50 ms đã hết.
    global.fetch = jest.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
          );
        }),
    ) as unknown as typeof fetch;
    const err = await new HttpGhnClient(cfg, 50).detail("GHN1").catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "timeout" });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpGhnClient — tạo/hủy vận đơn (không idempotent)", () => {
  it("timeout / 5xx / lỗi mạng → KHÔNG retry tự động (caller tra theo client_order_code — S-303)", async () => {
    for (const r of ["timeout", { status: 502 }, "network"] as Reply[]) {
      const s = scripted([r, { status: 200, body: CREATED }]);
      global.fetch = s.fn;
      await expect(client().c.createOrder(input)).rejects.toBeInstanceOf(GhnError);
      expect(s.requests).toHaveLength(1);
    }
    const s = scripted([{ status: 503 }, { status: 200, body: { code: 200 } }]);
    global.fetch = s.fn;
    await expect(client().c.cancel("GHN1")).rejects.toMatchObject({ kind: "unavailable" });
    expect(s.requests).toHaveLength(1);
  });

  it("429 + Retry-After: 2 → chờ ĐÚNG 2 s rồi gửi lại CÙNG client_order_code; không có header Idempotency-Key", async () => {
    const s = scripted([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: CREATED },
    ]);
    global.fetch = s.fn;
    const { c, sleeps } = client();
    expect(await c.createOrder(input)).toEqual({ orderCode: "GHN9", fee: 22_000 });
    expect(sleeps).toEqual([2_000]);
    expect(s.requests).toHaveLength(2);
    const bodies = s.requests.map((r) => JSON.parse(String(r.init.body)) as Record<string, unknown>);
    expect(bodies[0]!.client_order_code).toBe("XS-ABCDEF-S1");
    expect(bodies[1]).toEqual(bodies[0]);
    for (const r of s.requests) {
      const names = Object.keys(r.init.headers as Record<string, string>).map((h) => h.toLowerCase());
      expect(names).not.toContain("idempotency-key");
      expect(names).toEqual(expect.arrayContaining(["token", "shopid"]));
    }
  });

  it("429 + Retry-After HTTP-date → chờ tới mốc đó", async () => {
    const at = new Date(Math.floor(Date.now() / 1000) * 1000 + 2_000);
    const s = scripted([
      { status: 429, headers: { "Retry-After": at.toUTCString() } },
      { status: 200, body: CREATED },
    ]);
    global.fetch = s.fn;
    const { c, sleeps } = client();
    await c.createOrder(input);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(500);
    expect(sleeps[0]).toBeLessThanOrEqual(2_000);
  });

  it("429 Retry-After vượt ngân sách (120 s) → không chờ trong request, lỗi mang retryAfterMs cho caller hẹn lại", async () => {
    const s = scripted([{ status: 429, headers: { "Retry-After": "120" } }]);
    global.fetch = s.fn;
    const { c, sleeps } = client();
    const err = await c.createOrder(input).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable", status: 429, retryAfterMs: 120_000 });
    expect(sleeps).toEqual([]);
    expect(s.requests).toHaveLength(1);
  });

  it("429 không có / giá trị lạ Retry-After → bỏ qua giá trị, không retry ngay; Retry-After khổng lồ bị kẹp 1 giờ", async () => {
    for (const headers of [undefined, { "Retry-After": "soon" }, { "Retry-After": "-3" }]) {
      const s = scripted([{ status: 429, headers }]);
      global.fetch = s.fn;
      const err = await client()
        .c.detail("GHN1")
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 429, retryAfterMs: null });
      expect(s.requests).toHaveLength(1);
    }
    const s = scripted([{ status: 429, headers: { "Retry-After": "999999" } }]);
    global.fetch = s.fn;
    expect(
      await client()
        .c.detail("GHN1")
        .catch((e: unknown) => e),
    ).toMatchObject({
      retryAfterMs: GHN_RETRY_POLICY.maxRetryAfterMs,
    });
  });

  it("503 + Retry-After được đọc (cho caller), 500 thì không", async () => {
    let s = scripted([{ status: 503, headers: { "Retry-After": "600" } }]);
    global.fetch = s.fn;
    expect(
      await client()
        .c.createOrder(input)
        .catch((e: unknown) => e),
    ).toMatchObject({
      status: 503,
      retryAfterMs: 600_000,
    });
    s = scripted([{ status: 500, headers: { "Retry-After": "600" } }]);
    global.fetch = s.fn;
    expect(
      await client()
        .c.createOrder(input)
        .catch((e: unknown) => e),
    ).toMatchObject({
      status: 500,
      retryAfterMs: null,
    });
  });
});

describe("classifyGhnError / MockModeGhnClient rate_limited", () => {
  it("rejected/not_served vĩnh viễn; lỗi không phải GhnError không retry", () => {
    expect(classifyGhnError(new GhnError("rejected", "x"))).toEqual({ retry: false });
    expect(classifyGhnError(new GhnError("not_served", "x"))).toEqual({ retry: false });
    expect(new GhnError("rejected", "x").permanent).toBe(true);
    expect(new GhnError("unavailable", "x").permanent).toBe(false);
    expect(classifyGhnError(new Error("x"))).toEqual({ retry: false });
    expect(classifyGhnError(new GhnError("timeout", "x"))).toEqual({
      retry: true,
      processed: "maybe",
      retryAfterMs: null,
    });
  });

  it("fault rate_limited: 429 + retryAfterMs, không ghi vận đơn; lần sau tạo bình thường", async () => {
    const m = new MockModeGhnClient();
    m.createFaults.push("rate_limited");
    await expect(m.createOrder(input)).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
    expect(m.mock.created).toBe(0);
    await m.createOrder(input);
    expect(m.mock.created).toBe(1);
  });
});
