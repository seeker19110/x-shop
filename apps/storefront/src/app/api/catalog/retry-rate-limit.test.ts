// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../../../lib/http/retry";
import { resetEnvCacheForTests } from "../../../lib/env";
import { GET as wardsRoute } from "../address/wards/route";
import { GET as countRoute } from "./count/route";
import { GET as suggestRoute } from "./suggest/route";

vi.mock("../../../lib/security/client-ip", () => ({ clientIpHeader: async () => ({}) }));

/**
 * Backend giới hạn tốc độ (429 + Retry-After) → route chuyển tiếp 429 + Retry-After → client KHÔNG retry: đúng 1 lượt gọi
 * backend cho mỗi lần gõ/đếm (retry sẽ nhân tải lên backend đang bị giới hạn).
 */
const saved = { ...process.env };
let backendCalls = 0;
let backendReply: () => Response;

beforeEach(() => {
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test_123";
  resetEnvCacheForTests();
  backendCalls = 0;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("http://backend.test:9000")) {
      backendCalls += 1;
      return backendReply();
    }
    const route = url.startsWith("/api/address/wards")
      ? wardsRoute
      : url.startsWith("/api/catalog/count")
        ? countRoute
        : suggestRoute;
    return route(new Request(`http://storefront.test${url}`));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCacheForTests();
});

const noSleep = { sleep: async () => undefined, random: () => 0 };

describe("retry × giới hạn tốc độ của backend", () => {
  it.each([
    ["suggest", "/api/catalog/suggest?q=ao"],
    ["count", "/api/catalog/count"],
  ])("%s: backend 429 + Retry-After → route 429 + Retry-After, đúng 1 lượt gọi backend", async (_n, path) => {
    backendReply = () => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    const res = await fetchWithRetry(path, {}, noSleep);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(backendCalls).toBe(1);
  });

  it("backend 429 không kèm Retry-After → route đặt mặc định 60 giây (vượt trần client) → 1 lượt", async () => {
    backendReply = () => new Response("{}", { status: 429 });
    const res = await fetchWithRetry("/api/catalog/suggest?q=ao", {}, noSleep);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(backendCalls).toBe(1);
  });

  it("đối chứng: backend 503 (lỗi tạm thời thật) vẫn được retry tới trần", async () => {
    backendReply = () => new Response("{}", { status: 503 });
    const res = await fetchWithRetry("/api/catalog/count", {}, noSleep);
    expect(res.status).toBe(503);
    // Chỉ MỘT tầng retry: client 1 + 3 lần thử lại = 4 lượt; mỗi lượt route gọi backend đúng 1 lần (maxRetries 0)
    // → 4 × 1 = 4 (không phải 4 × 2 = 8 như khi retry lồng).
    expect(backendCalls).toBe(4);
  });
});

describe("proxy count/suggest: một tầng retry, hạn server < hạn client, nối signal của request", () => {
  it.each([
    ["count", countRoute, "http://storefront.test/api/catalog/count"],
    ["suggest", suggestRoute, "http://storefront.test/api/catalog/suggest?q=ao"],
  ])(
    "%s: request.signal tới fetch backend; request huỷ → backend không bị gọi lại",
    async (_n, route, url) => {
      const seen: AbortSignal[] = [];
      vi.stubGlobal("fetch", (_u: unknown, init?: RequestInit) => {
        backendCalls += 1;
        if (init?.signal) seen.push(init.signal);
        return new Promise<Response>((_res, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      });
      const ctrl = new AbortController();
      const p = route(new Request(url, { signal: ctrl.signal }));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]!.aborted).toBe(false);
      ctrl.abort();
      expect((await p).status).toBe(503);
      expect(seen[0]!.aborted).toBe(true);
      expect(backendCalls).toBe(1); // không retry lồng sau khi huỷ
    },
  );
});

describe("retry × phường/xã", () => {
  it("mã tỉnh sai (backend 404) → route 404, client không retry; nguồn lỗi (500) → route 503, retry tới trần", async () => {
    backendReply = () => new Response("{}", { status: 404 });
    const notFound = await fetchWithRetry("/api/address/wards?province=99", {}, noSleep);
    expect(notFound.status).toBe(404);
    expect(backendCalls).toBe(1);
    backendCalls = 0;
    backendReply = () => new Response("{}", { status: 500 });
    const down = await fetchWithRetry("/api/address/wards?province=01", {}, noSleep);
    expect(down.status).toBe(503);
    expect(backendCalls).toBe(4);
  });
});
