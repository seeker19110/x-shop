import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  fetchWithRetry,
  isRetryableRequest,
  isTransientError,
  isTransientStatus,
  parseRetryAfterMs,
} from "./retry";

afterEach(() => vi.unstubAllGlobals());

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : "{}", { status, headers });

/** fetch giả trả lần lượt các kết quả (Response hoặc lỗi); đếm số lần gọi. */
function stubFetch(...steps: Array<Response | Error | DOMException>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (s instanceof Response) return s.clone();
    throw s;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const delays: number[] = [];
const sleep = vi.fn(async (ms: number) => {
  delays.push(ms);
});
const opts = { sleep, random: () => 0.5 };
const reset = () => {
  delays.length = 0;
  sleep.mockClear();
};

describe("isTransientStatus", () => {
  it.each([408, 429, 500, 502, 503, 504])("%i là tạm thời", (s) => {
    expect(isTransientStatus(s)).toBe(true);
  });
  it.each([200, 201, 204, 301, 400, 401, 403, 404, 409, 410, 422, 501, 505])("%i không phải", (s) => {
    expect(isTransientStatus(s)).toBe(false);
  });
});

describe("isTransientError", () => {
  it("lỗi mạng (TypeError) và TimeoutError là tạm thời; AbortError và giá trị lạ thì không", () => {
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientError(new DOMException("hết giờ", "TimeoutError"))).toBe(true);
    expect(isTransientError(new DOMException("huỷ", "AbortError"))).toBe(false);
    expect(isTransientError(new Error("lạ"))).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError("lỗi")).toBe(false);
  });
});

describe("isRetryableRequest", () => {
  it("GET/HEAD/OPTIONS an toàn; POST/PUT/PATCH/DELETE thì không, trừ khi idempotent", () => {
    for (const m of ["GET", "get", "HEAD", "OPTIONS"])
      expect(isRetryableRequest(m, new Headers())).toBe(true);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isRetryableRequest(m, new Headers())).toBe(false);
      expect(isRetryableRequest(m, new Headers(), true)).toBe(true);
    }
  });
  it("POST có Idempotency-Key (không phân biệt hoa thường) retry được", () => {
    expect(isRetryableRequest("POST", new Headers({ "Idempotency-Key": "k".repeat(20) }))).toBe(true);
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-10-26T10:00:00Z");
  it("giây nguyên → ms; 0 là giá trị thật", () => {
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs(" 5 ", now)).toBe(5000);
  });
  it("ngày HTTP → khoảng chờ từ bây giờ; ngày đã qua → 0", () => {
    expect(parseRetryAfterMs("Mon, 26 Oct 2026 10:00:07 GMT", now)).toBe(7000);
    expect(parseRetryAfterMs("Mon, 26 Oct 2026 09:00:00 GMT", now)).toBe(0);
  });
  it("số nguyên rất lớn (> 2^53) → Infinity (chờ rất lâu) và không retry", async () => {
    expect(parseRetryAfterMs("99999999999999999999", Date.now())).toBe(Number.POSITIVE_INFINITY);
    reset();
    const f = stubFetch(res(503, { "retry-after": "99999999999999999999" }), res(200));
    expect((await fetchWithRetry("/x", {}, opts)).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("rỗng/null/sai/âm/thập phân → null (không coi là 0 để khỏi gửi dồn)", () => {
    for (const v of [null, "", "  ", "abc", "-3", "1.5"]) {
      expect(parseRetryAfterMs(v, now)).toBeNull();
    }
  });
});

describe("backoffDelayMs", () => {
  it("jitter đầy đủ trong [0, trần]; trần tăng gấp đôi rồi bị chặn bởi max", () => {
    expect(backoffDelayMs(0, 250, 4000, () => 0)).toBe(0);
    expect(backoffDelayMs(0, 250, 4000, () => 0.999999)).toBe(249);
    expect(backoffDelayMs(1, 250, 4000, () => 0.999999)).toBe(499);
    expect(backoffDelayMs(2, 250, 4000, () => 0.999999)).toBe(999);
    expect(backoffDelayMs(10, 250, 4000, () => 0.999999)).toBe(3999);
    expect(backoffDelayMs(1000, 250, 4000, () => 0.999999)).toBe(3999);
  });
});

describe("fetchWithRetry — lỗi tạm thời", () => {
  it("503 rồi 200 → trả 200, đúng 2 lần gọi, có chờ giữa hai lần", async () => {
    reset();
    const f = stubFetch(res(503), res(200));
    const r = await fetchWithRetry("/x", {}, opts);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([125]); // 0.5 × 250
  });

  it.each([408, 429, 500, 502, 503, 504])("%i được retry", async (status) => {
    reset();
    const f = stubFetch(res(status), res(200));
    expect((await fetchWithRetry("/x", {}, opts)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lỗi mạng rồi thành công → retry", async () => {
    reset();
    const f = stubFetch(new TypeError("fetch failed"), res(200));
    expect((await fetchWithRetry("/x", {}, opts)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lỗi tạm thời kéo dài: dừng ở trần 3 lần thử lại (4 lần gọi) và trả phản hồi lỗi cuối", async () => {
    reset();
    const f = stubFetch(res(503));
    const r = await fetchWithRetry("/x", {}, opts);
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([125, 250, 500]); // backoff tăng dần (random 0.5)
  });

  it("lỗi mạng kéo dài: ném lỗi cuối sau 4 lần gọi", async () => {
    reset();
    const f = stubFetch(new TypeError("fetch failed"));
    await expect(fetchWithRetry("/x", {}, opts)).rejects.toThrow("fetch failed");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("maxRetries: 0 → không retry", async () => {
    reset();
    const f = stubFetch(res(503));
    expect((await fetchWithRetry("/x", {}, { ...opts, maxRetries: 0 })).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("TimeoutError (AbortSignal.timeout) được retry", async () => {
    reset();
    const f = stubFetch(new DOMException("hết giờ", "TimeoutError"), res(200));
    expect((await fetchWithRetry("/x", {}, opts)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("onRetry nhận số lần, thời gian chờ và lý do", async () => {
    reset();
    stubFetch(res(502), res(200));
    const onRetry = vi.fn();
    await fetchWithRetry("/x", {}, { ...opts, onRetry });
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: 125, reason: "HTTP 502" });
  });
});

describe("fetchWithRetry — KHÔNG retry", () => {
  it.each([400, 401, 403, 404, 409, 410, 422, 501])("%i → trả ngay, đúng 1 lần gọi", async (status) => {
    reset();
    const f = stubFetch(res(status), res(200));
    expect((await fetchWithRetry("/x", {}, opts)).status).toBe(status);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("2xx → 1 lần gọi", async () => {
    reset();
    const f = stubFetch(res(200));
    await fetchWithRetry("/x", {}, opts);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("POST không idempotent gặp 503 → không retry (tránh tạo đơn/trừ tiền hai lần)", async () => {
    reset();
    const f = stubFetch(res(503), res(200));
    const r = await fetchWithRetry("/x", { method: "POST", body: "{}" }, opts);
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("POST gặp lỗi mạng → ném ngay, không gửi lại", async () => {
    reset();
    const f = stubFetch(new TypeError("fetch failed"), res(200));
    await expect(fetchWithRetry("/x", { method: "POST", body: "{}" }, opts)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("lỗi không phải mạng (Error thường) → ném ngay", async () => {
    reset();
    const f = stubFetch(new Error("lạ"), res(200));
    await expect(fetchWithRetry("/x", {}, opts)).rejects.toThrow("lạ");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("người dùng huỷ (AbortError) → ném ngay, không retry", async () => {
    reset();
    const f = stubFetch(new DOMException("huỷ", "AbortError"), res(200));
    await expect(fetchWithRetry("/x", {}, opts)).rejects.toMatchObject({ name: "AbortError" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("signal đã huỷ khi đang chờ backoff → dừng, không gọi lần nữa", async () => {
    reset();
    const ctrl = new AbortController();
    const f = stubFetch(res(503), res(200));
    const abortingSleep = vi.fn(async () => {
      ctrl.abort();
    });
    await expect(
      fetchWithRetry("/x", { signal: ctrl.signal }, { ...opts, sleep: abortingSleep }),
    ).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("lỗi mạng khi signal đã huỷ → ném, không retry", async () => {
    reset();
    const ctrl = new AbortController();
    ctrl.abort();
    const f = stubFetch(new TypeError("fetch failed"), res(200));
    await expect(fetchWithRetry("/x", { signal: ctrl.signal }, opts)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry — POST idempotent", () => {
  it("POST có Idempotency-Key được retry và gửi LẠI cùng khóa", async () => {
    reset();
    const f = stubFetch(res(503), res(200));
    const init = { method: "POST", body: "{}", headers: { "Idempotency-Key": "abcdefghijklmnop1234" } };
    expect((await fetchWithRetry("/x", init, opts)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[1]![1].headers).toEqual(calls[0]![1].headers);
  });

  it("idempotent: true do người gọi khai → retry; 400 vẫn không retry", async () => {
    reset();
    const f = stubFetch(res(429), res(200));
    expect((await fetchWithRetry("/x", { method: "POST" }, { ...opts, idempotent: true })).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    const g = stubFetch(res(400), res(200));
    expect((await fetchWithRetry("/x", { method: "POST" }, { ...opts, idempotent: true })).status).toBe(400);
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry — Retry-After", () => {
  it("429 + Retry-After: 2 → chờ ít nhất 2000 ms (hơn backoff)", async () => {
    reset();
    stubFetch(res(429, { "retry-after": "2" }), res(200));
    await fetchWithRetry("/x", {}, opts);
    expect(delays).toEqual([2000]);
  });

  it("backoff lớn hơn Retry-After thì lấy backoff (luôn ≥ Retry-After)", async () => {
    reset();
    stubFetch(res(503, { "retry-after": "0" }), res(200));
    await fetchWithRetry("/x", {}, { ...opts, random: () => 0.9 });
    expect(delays).toEqual([225]);
  });

  it("ngày HTTP được tôn trọng", async () => {
    reset();
    stubFetch(res(503, { "retry-after": "Mon, 26 Oct 2026 10:00:03 GMT" }), res(200));
    await fetchWithRetry("/x", {}, { ...opts, now: () => Date.parse("2026-10-26T10:00:00Z") });
    expect(delays).toEqual([3000]);
  });

  it("Retry-After vượt trần (30 giây > 10 giây) → không retry, trả phản hồi lỗi", async () => {
    reset();
    const f = stubFetch(res(503, { "retry-after": "30" }), res(200));
    const r = await fetchWithRetry("/x", {}, opts);
    expect(r.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("Retry-After rỗng/sai → dùng backoff, không phải 0 ms", async () => {
    reset();
    stubFetch(res(503, { "retry-after": "" }), res(200));
    await fetchWithRetry("/x", {}, opts);
    expect(delays).toEqual([125]);
  });
});
