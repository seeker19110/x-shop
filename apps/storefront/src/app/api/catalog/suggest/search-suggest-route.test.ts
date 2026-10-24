// @vitest-environment node
import { resetEnvCacheForTests } from "../../../../lib/env";
import { GET } from "./route";

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.XS_DATA_SOURCE;
  delete process.env.MEDUSA_BACKEND_URL;
  resetEnvCacheForTests();
});
afterEach(() => {
  process.env = { ...saved };
  resetEnvCacheForTests();
  vi.unstubAllGlobals();
});

const call = (q?: string) =>
  GET(
    new Request(`http://x.test/api/catalog/suggest${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`),
  );

describe("GET /api/catalog/suggest (fixtures)", () => {
  it("gợi ý theo tên, có/không dấu, ≤ 8, không trùng, cache công khai", async () => {
    const res = await call("ao");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    const { suggestions } = (await res.json()) as { suggestions: string[] };
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(8);
    expect(new Set(suggestions).size).toBe(suggestions.length);
    expect(suggestions.every((s) => typeof s === "string")).toBe(true);
    const accented = (await (await call("áo")).json()) as { suggestions: string[] };
    expect(accented.suggestions).toEqual(suggestions);
  });

  it("thiếu q, rỗng, 1 ký tự → rỗng, không gọi nguồn dữ liệu", async () => {
    for (const q of [undefined, "", "   ", "a"]) {
      expect(await (await call(q)).json()).toEqual({ suggestions: [] });
    }
  });

  it("truy vấn rất dài bị cắt 100 ký tự, không lỗi; không khớp → rỗng", async () => {
    const res = await call("áo ".repeat(200));
    expect(res.status).toBe(200);
    expect(await (await call("zzzzqqxx")).json()).toEqual({ suggestions: [] });
  });

  it("nguồn backend lỗi → 503 + danh sách rỗng (client chỉ đóng gợi ý)", async () => {
    process.env.XS_DATA_SOURCE = "backend";
    process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
    resetEnvCacheForTests();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 502 }));
    const res = await call("áo");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});
