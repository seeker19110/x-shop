import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS,
  CLIENT_FETCH_MAX_RETRIES,
  CLIENT_FETCH_MAX_RETRY_AFTER_MS,
  CLIENT_FETCH_TIMEOUT_MS,
  ClientFetchError,
  clientFetch,
} from "./client-fetch";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });

/** fetch giả: mỗi lần gọi lấy bước kế tiếp; bước "hang" treo tới khi signal huỷ (giống fetch thật). */
type Step = Response | Error | "hang";
function stubFetch(...steps: Step[]) {
  let i = 0;
  const fn = vi.fn((_input: unknown, init?: RequestInit) => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    if (init?.signal?.aborted === true) return Promise.reject(init.signal.reason); // như fetch thật
    if (s === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return s instanceof Response ? Promise.resolve(s.clone()) : Promise.reject(s);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("clientFetch — timeout", () => {
  it("fetch treo → ClientFetchError TIMEOUT sau đúng hạn (không sleep thật), không retry POST", async () => {
    const f = stubFetch("hang");
    const p = clientFetch("/x", { method: "POST" }, { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ name: "ClientFetchError", code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("thông điệp lỗi nêu hạn; mặc định hạn là CLIENT_FETCH_TIMEOUT_MS", async () => {
    stubFetch("hang");
    const p = clientFetch("/x", { method: "POST" });
    const assertion = expect(p).rejects.toThrow(`${CLIENT_FETCH_TIMEOUT_MS} ms`);
    await vi.advanceTimersByTimeAsync(CLIENT_FETCH_TIMEOUT_MS);
    await assertion;
  });

  it("GET treo mãi: mỗi lần có hạn riêng, thử lại tới trần rồi báo TIMEOUT", async () => {
    const f = stubFetch("hang");
    const p = clientFetch("/x", {}, { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toBeInstanceOf(ClientFetchError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(CLIENT_FETCH_MAX_RETRIES + 1);
  });

  it("lần đầu treo, lần sau thành công → trả phản hồi", async () => {
    const f = stubFetch("hang", res(200));
    const p = clientFetch("/x", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("timeoutMs không hợp lệ (0, âm, NaN, Infinity) → RangeError, không gọi mạng", async () => {
    const f = stubFetch(res(200));
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(clientFetch("/x", {}, { timeoutMs: t })).rejects.toBeInstanceOf(RangeError);
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe("clientFetch — retry", () => {
  it.each([502, 503, 504])("%i rồi 200 → retry đúng 1 lần", async (status) => {
    const f = stubFetch(res(status), res(200));
    const p = clientFetch("/x");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lỗi mạng rồi 200 → retry", async () => {
    const f = stubFetch(new TypeError("fetch failed"), res(200));
    const p = clientFetch("/x");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lỗi mạng kéo dài → NETWORK sau 1 + CLIENT_FETCH_MAX_RETRIES lần gọi", async () => {
    const f = stubFetch(new TypeError("fetch failed"));
    const p = clientFetch("/x");
    const assertion = expect(p).rejects.toMatchObject({ code: "NETWORK" });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(CLIENT_FETCH_MAX_RETRIES + 1);
  });

  it("503 kéo dài → trả phản hồi 503 (không ném) sau số lần gọi tối đa", async () => {
    const f = stubFetch(res(503));
    const p = clientFetch("/x");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await p).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(CLIENT_FETCH_MAX_RETRIES + 1);
  });

  it.each([400, 401, 403, 404, 409, 422])("%i không retry", async (status) => {
    const f = stubFetch(res(status), res(200));
    expect((await clientFetch("/x")).status).toBe(status);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("POST gặp 503 → không retry (tránh tạo/trừ hai lần)", async () => {
    const f = stubFetch(res(503), res(200));
    expect((await clientFetch("/x", { method: "POST", body: "{}" })).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("POST lỗi mạng → không retry, ném NETWORK", async () => {
    const f = stubFetch(new TypeError("fetch failed"), res(200));
    await expect(clientFetch("/x", { method: "POST" })).rejects.toMatchObject({ code: "NETWORK" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maxRetries: 0 → một lần gọi", async () => {
    const f = stubFetch(res(503), res(200));
    expect((await clientFetch("/x", {}, { maxRetries: 0 })).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

/** Phản hồi 200 có thân treo tới khi signal huỷ (luồng lỗi với lý do huỷ, như fetch thật). */
function stubHangingBody() {
  vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  });
}

describe("clientFetch — hết hạn khi đọc thân", () => {
  it("r.json() treo quá hạn → ClientFetchError TIMEOUT (không phải DOMException thô)", async () => {
    stubHangingBody();
    const r = await clientFetch("/x", {}, { timeoutMs: 1000 });
    expect(r.status).toBe(200);
    const p = r.json();
    const assertion = expect(p).rejects.toMatchObject({ name: "ClientFetchError", code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("clone() cũng được bọc; signal ngoài huỷ khi đang đọc thân → ABORTED", async () => {
    stubHangingBody();
    const ctrl = new AbortController();
    const r = await clientFetch("/x", { signal: ctrl.signal }, { timeoutMs: 1000 });
    const p = r.clone().text();
    const assertion = expect(p).rejects.toMatchObject({ code: "ABORTED" });
    ctrl.abort();
    await assertion;
  });

  it("JSON hỏng → giữ nguyên SyntaxError; thân tốt đọc bình thường; header/status không đổi", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("không phải json", { status: 200, headers: { "x-a": "1" } }),
    );
    const bad = await clientFetch("/x");
    expect(bad.headers.get("x-a")).toBe("1");
    await expect(bad.json()).rejects.toBeInstanceOf(SyntaxError);
    vi.stubGlobal("fetch", async () => new Response('{"a":1}', { status: 200 }));
    const good = await clientFetch("/x");
    expect(await good.json()).toEqual({ a: 1 });
    expect(good.ok).toBe(true);
  });
});

describe("clientFetch — Retry-After", () => {
  it("429 + Retry-After 3 s → chờ ≥ 3 s mới gọi lại", async () => {
    const f = stubFetch(res(429, { "retry-after": "3" }), res(200));
    const p = clientFetch("/x");
    await vi.advanceTimersByTimeAsync(2999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("Retry-After vượt trần → trả 429 ngay, không chờ, không retry", async () => {
    const f = stubFetch(
      res(429, { "retry-after": String(CLIENT_FETCH_MAX_RETRY_AFTER_MS / 1000 + 1) }),
      res(200),
    );
    expect((await clientFetch("/x")).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("Retry-After = 0 là giá trị thật → retry (sau backoff), thành công", async () => {
    const f = stubFetch(res(503, { "retry-after": "0" }), res(200));
    const p = clientFetch("/x");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("clientFetch — huỷ bởi signal ngoài (unmount)", () => {
  it("abort khi đang chờ phản hồi → ABORTED ngay, không retry, không chờ hết hạn", async () => {
    const f = stubFetch("hang");
    const ctrl = new AbortController();
    const p = clientFetch("/x", { signal: ctrl.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: "ABORTED" });
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("abort khi đang chờ backoff giữa hai lần → ABORTED, không gọi lần nữa", async () => {
    const f = stubFetch(res(429, { "retry-after": "3" }), res(200));
    const ctrl = new AbortController();
    const p = clientFetch("/x", { signal: ctrl.signal });
    const assertion = expect(p).rejects.toMatchObject({ code: "ABORTED" });
    await vi.advanceTimersByTimeAsync(1000);
    ctrl.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("signal đã abort từ trước → ABORTED, hạn không để lại bộ hẹn giờ", async () => {
    stubFetch(res(200));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(clientFetch("/x", { signal: ctrl.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hết hạn KHÔNG bị nhầm với huỷ khi signal ngoài còn sống", async () => {
    stubFetch("hang");
    const ctrl = new AbortController();
    const p = clientFetch("/x", { method: "POST", signal: ctrl.signal }, { timeoutMs: 500 });
    const assertion = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});

describe("mọi client I/O có timeout (FE-STATE-005, XC-PERF-006)", () => {
  const COMPONENTS = join(import.meta.dirname, "..", "components");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const files = sources(COMPONENTS);

  /** Tham chiếu fetch trần hoặc qua global object (gọi, tham chiếu, computed, destructuring). Regex tuyến tính. */
  const usesRawFetch = (src: string): boolean =>
    /(?<![\w$.])fetch\s*\(/.test(src) ||
    /\b(?:globalThis|window|self)\s*\??\.\s*fetch\b/.test(src) ||
    /\b(?:globalThis|window|self)(?:\s*\??\.)?\s*\[\s*["'`]fetch["'`]\s*\]/.test(src) ||
    [...src.matchAll(/\{[^{}]*\}\s*=\s*(?:globalThis|window|self)\b/g)].some((m) => /\bfetch\b/.test(m[0]));

  it("bộ dò fetch trần: bắt các dạng vi phạm, bỏ qua mã vô hại", () => {
    for (const bad of [
      'fetch("/x")',
      'window.fetch("/x")',
      "const f = globalThis?.fetch;",
      'self["fetch"]("/x")',
      "window[`fetch`]",
      "const { fetch } = window;",
      "const { a, fetch: f } = globalThis;",
    ]) {
      expect(usesRawFetch(bad), bad).toBe(true);
    }
    for (const good of [
      "clientFetch('/x')",
      "prefetch={false}",
      "window.location",
      "const { a } = window;",
    ]) {
      expect(usesRawFetch(good), good).toBe(false);
    }
  });

  it("không component nào dùng fetch trần (bổ sung cho ESLint, bắt cả khi ai đó tắt luật)", () => {
    const offenders = files.filter((f) => usesRawFetch(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("component dùng I/O mạng đều đi qua clientFetch (bốn nơi đã biết: giỏ, địa chỉ, gợi ý, bộ lọc)", () => {
    const users = files
      .filter((f) => /(?<![\w$.])clientFetch\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(COMPONENTS.length + 1))
      .sort();
    expect(users).toEqual([
      "cart/CartBadge.tsx",
      "catalog/FilterDrawer.tsx",
      "catalog/SearchCombobox.tsx",
      "checkout/CheckoutForm.tsx",
    ]);
  });

  it("hạn tương tác (gợi ý/đếm/giỏ) ngắn hơn hạn mặc định", () => {
    expect(CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS).toBeLessThan(CLIENT_FETCH_TIMEOUT_MS);
  });
});
