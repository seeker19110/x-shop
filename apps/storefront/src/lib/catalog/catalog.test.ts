// @vitest-environment node
import { EMPTY_FILTER, parseFilter, type CatalogFilter } from "@x-shop/domain";
import { resetEnvCacheForTests } from "../env";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getCategories,
  getCategoryName,
  getMenuCategories,
  getProduct,
  listProducts,
  PROXY_BACKEND_TIMEOUT_MS,
  proxyNet,
  search,
} from "./client";
import { CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS } from "../client-fetch";
import { FIXTURE_PRODUCTS } from "./fixtures";
import { CatalogError } from "./types";

vi.mock("../content/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../content/navigation")>();
  return {
    ...actual,
    NAV_CATEGORIES: [...actual.NAV_CATEGORIES, { handle: "nhom-trong", name: "Nhóm trống" }],
  };
});

const f = (q: string): CatalogFilter => parseFilter(new URLSearchParams(q)).filter;
const handles = (r: { items: { handle: string }[] }) => r.items.map((i) => i.handle);

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCacheForTests();
  vi.unstubAllGlobals();
});

describe("fixtures (mặc định khi không có MEDUSA_BACKEND_URL)", () => {
  beforeEach(() => {
    delete process.env.XS_DATA_SOURCE;
    delete process.env.MEDUSA_BACKEND_URL;
    resetEnvCacheForTests();
  });

  it("có ≥ 16 sản phẩm, handle duy nhất, ảnh cục bộ có width/height, giá nguyên", () => {
    expect(FIXTURE_PRODUCTS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(FIXTURE_PRODUCTS.map((p) => p.handle)).size).toBe(FIXTURE_PRODUCTS.length);
    for (const p of FIXTURE_PRODUCTS) {
      expect(p.images.length).toBeGreaterThanOrEqual(3);
      for (const i of p.images) {
        expect(i.url.startsWith("/demo/")).toBe(true);
        expect(i.width).toBeGreaterThan(0);
        expect(i.alt.length).toBeGreaterThan(5);
      }
      for (const v of p.variants) expect(Number.isInteger(v.price)).toBe(true);
    }
  });

  it("AT01: đen-S + trắng-M không khớp color=den&size=m", async () => {
    const r = await listProducts(f("color=den&size=m"));
    expect(handles(r)).not.toContain("ao-so-mi-lua");
    expect(handles(r)).toContain("ao-so-mi-oxford");
  });

  it("AT31: đen-M 700.000 / trắng-S 300.000 — lọc đen-M dưới 500.000 loại sản phẩm; bỏ giá thì card hiện 700.000", async () => {
    const filtered = await listProducts(f("color=den&size=m&price_max=500000"));
    expect(handles(filtered)).not.toContain("ao-khoac-kaki-mong");
    const r = await listProducts(f("color=den&size=m"));
    const item = r.items.find((i) => i.handle === "ao-khoac-kaki-mong")!;
    expect([item.price_min, item.price_max]).toEqual([700000, 700000]);
    const all = await listProducts(EMPTY_FILTER, { pageSize: 48 });
    const range = all.items.find((i) => i.handle === "ao-khoac-kaki-mong")!;
    expect([range.price_min, range.price_max]).toEqual([300000, 700000]);
  });

  it("hết hàng: in_stock=false; lọc in_stock=1 loại sản phẩm đó", async () => {
    const all = await listProducts(EMPTY_FILTER, { pageSize: 48 });
    expect(all.items.find((i) => i.handle === "quan-tay-ong-dung")?.in_stock).toBe(false);
    const stock = await listProducts(f("in_stock=1"), { pageSize: 48 });
    expect(handles(stock)).not.toContain("quan-tay-ong-dung");
  });

  it("giảm giá: compare_at_max có ở sản phẩm giảm, null ở sản phẩm không giảm", async () => {
    const all = await listProducts(EMPTY_FILTER, { pageSize: 48 });
    expect(all.items.find((i) => i.handle === "ao-thun-cotton-co-tron")?.compare_at_max).toBe(390000);
    expect(all.items.find((i) => i.handle === "ao-so-mi-lua")?.compare_at_max).toBeNull();
  });

  it("danh mục thu hẹp kết quả và facet; total đếm theo bộ lọc", async () => {
    const r = await listProducts(EMPTY_FILTER, { category: "phu-kien", pageSize: 48 });
    expect(handles(r).sort()).toEqual(["that-lung-da", "tui-tote-vai-canvas"]);
    expect(r.total).toBe(2);
    expect(r.facets.size.map((s) => s.value)).toEqual(["s", "m", "l", "free"]);
  });

  it("phân trang: trang 2 là phần còn lại, trang quá tổng rỗng nhưng vẫn báo total", async () => {
    const p1 = await listProducts(f("page=1"), { pageSize: 12 });
    const p2 = await listProducts(f("page=2"), { pageSize: 12 });
    expect(p1.items).toHaveLength(12);
    expect(p2.items).toHaveLength(FIXTURE_PRODUCTS.length - 12);
    expect(p1.total).toBe(FIXTURE_PRODUCTS.length);
    const far = await listProducts(f("page=99"), { pageSize: 12 });
    expect(far.items).toEqual([]);
    expect(far.total).toBe(FIXTURE_PRODUCTS.length);
  });

  it("page_size bị kẹp 48", async () => {
    expect((await listProducts(EMPTY_FILTER, { pageSize: 1000 })).page_size).toBe(48);
  });

  it("sắp xếp giá tăng/giảm dùng giá SKU khớp", async () => {
    const asc = await listProducts(f("sort=price_asc"), { pageSize: 48 });
    const mins = asc.items.map((i) => i.price_min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    const desc = await listProducts(f("sort=price_desc"), { pageSize: 48 });
    const maxes = desc.items.map((i) => i.price_max);
    expect(maxes).toEqual([...maxes].sort((a, b) => b - a));
  });

  it("price_min > price_max → INVALID_RANGE (giống API 422)", async () => {
    await expect(listProducts(f("price_min=500000&price_max=100000"))).rejects.toMatchObject({
      code: "INVALID_RANGE",
    });
  });

  it("tìm có/không dấu, hoa/thường, theo SKU và theo danh mục (CAT01)", async () => {
    for (const q of ["ao so mi", "ÁO SƠ MI", "so mi lua", "SML-DEN-S", "váy"]) {
      const r = await search(f(`q=${encodeURIComponent(q)}`));
      expect(r.total, q).toBeGreaterThan(0);
    }
    expect(handles(await search(f("q=so mi lua")))).toContain("ao-so-mi-lua");
    expect(handles(await search(f("q=SML-DEN-S")))).toEqual(["ao-so-mi-lua"]);
  });

  it("tìm không có kết quả → gợi ý danh mục; có kết quả → không gợi ý", async () => {
    const none = await search(f("q=xyzxyz"));
    expect(none.total).toBe(0);
    expect(none.suggestions?.map((s) => s.handle)).toEqual(["ao", "quan", "vay", "phu-kien"]);
    expect((await search(f("q=ao"))).suggestions).toBeUndefined();
  });

  it("getProduct: có handle → chi tiết; không có → null", async () => {
    expect((await getProduct("ao-so-mi-lua"))?.variants).toHaveLength(2);
    expect(await getProduct("khong-ton-tai")).toBeNull();
  });

  it("menu chỉ gồm nhóm có sản phẩm (nhóm cấu hình nhưng trống bị loại)", async () => {
    const menu = await getMenuCategories();
    expect(menu.map((c) => c.handle)).toEqual(["ao", "quan", "vay", "phu-kien"]);
  });
});

describe("backend (XS_DATA_SOURCE=backend)", () => {
  beforeEach(() => {
    process.env.XS_DATA_SOURCE = "backend";
    process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
    process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test_123";
    resetEnvCacheForTests();
  });

  const ok = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("gọi /store/x/products với query chuẩn hóa, category, page_size và header publishable key", async () => {
    const fetchMock = vi.fn(async () =>
      ok({ items: [], facets: { color: [], size: [], material: [] }, total: 0, page: 1, page_size: 12 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await listProducts(f("size=m&color=trang,den&sort=price_asc"), { category: "ao" });
    const calls = fetchMock.mock.calls as unknown as [
      string,
      RequestInit & { next?: { revalidate: number } },
    ][];
    const [url, init] = calls[0]!;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("http://backend.test:9000/store/x/products");
    expect(u.searchParams.get("color")).toBe("den,trang");
    expect(u.searchParams.get("category")).toBe("ao");
    expect(u.searchParams.get("page_size")).toBe("12");
    expect((init.headers as Record<string, string>)["x-publishable-api-key"]).toBe("pk_test_123");
    expect(init.next?.revalidate).toBe(60);
  });

  it("search gọi /store/x/search", async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        items: [],
        facets: { color: [], size: [], material: [] },
        total: 0,
        page: 1,
        page_size: 12,
        suggestions: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await search(f("q=ao"));
    const calls = fetchMock.mock.calls as unknown as [string][];
    expect(new URL(calls[0]![0]).pathname).toBe("/store/x/search");
  });

  it("422 INVALID_RANGE / VALIDATION → CatalogError mã tương ứng", async () => {
    vi.stubGlobal("fetch", async () => ok({ code: "INVALID_RANGE", detail: "Giá sai khoảng" }, 422));
    await expect(listProducts(EMPTY_FILTER)).rejects.toMatchObject({ code: "INVALID_RANGE", status: 422 });
    vi.stubGlobal("fetch", async () => ok({ code: "VALIDATION" }, 422));
    await expect(listProducts(EMPTY_FILTER)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("5xx hoặc lỗi mạng → UNAVAILABLE (không lộ chi tiết)", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 502 }));
    await expect(listProducts(EMPTY_FILTER)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed ECONNREFUSED 10.0.0.1");
    });
    const err = await listProducts(EMPTY_FILTER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogError);
    expect((err as CatalogError).message).not.toContain("10.0.0.1");
  });

  it("GET có timeout + retry 1 lần cho 502/503/504; không retry 429/404/422", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // backoff 0 ms: không chờ thật
    const calls = { n: 0, signals: 0 };
    const reply = (first: Response, then: Response) =>
      vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
        calls.n += 1;
        if (init?.signal instanceof AbortSignal) calls.signals += 1;
        return (calls.n === 1 ? first : then).clone();
      });
    reply(new Response("x", { status: 503 }), ok({ data: [], count: 0 }));
    await listProducts(EMPTY_FILTER);
    expect(calls).toEqual({ n: 2, signals: 2 }); // mỗi lần gọi đều mang tín hiệu hết hạn
    for (const status of [429, 404, 422]) {
      calls.n = 0;
      reply(ok({}, status), ok({ data: [], count: 0 }));
      await listProducts(EMPTY_FILTER).catch((e: unknown) => e);
      expect(calls.n).toBe(1);
    }
    // Route proxy đặt maxRetries 0 (client đã retry): 503 → đúng 1 lần gọi backend, không retry lồng.
    calls.n = 0;
    reply(new Response("x", { status: 503 }), ok({ data: [], count: 0 }));
    await listProducts(EMPTY_FILTER, { net: { maxRetries: 0 } }).catch((e: unknown) => e);
    expect(calls.n).toBe(1);
    calls.n = 0;
    await search(EMPTY_FILTER, { net: { maxRetries: 0 } }).catch((e: unknown) => e);
    expect(calls.n).toBe(1);
    vi.restoreAllMocks();
  });

  it("proxyNet: không retry, hạn server < hạn client, signal của request tới tận fetch; huỷ → dừng, không retry", async () => {
    expect(PROXY_BACKEND_TIMEOUT_MS).toBeLessThan(CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS);
    const ctrl = new AbortController();
    expect(proxyNet(ctrl.signal)).toEqual({
      maxRetries: 0,
      timeoutMs: PROXY_BACKEND_TIMEOUT_MS,
      signal: ctrl.signal,
    });
    let n = 0;
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
      n += 1;
      seen = init?.signal;
      return new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const p = listProducts(EMPTY_FILTER, { net: proxyNet(ctrl.signal) }).catch((e: unknown) => e);
    await Promise.resolve();
    ctrl.abort(); // client bỏ đi (request.signal huỷ)
    expect(await p).toMatchObject({ code: "UNAVAILABLE" });
    expect(n).toBe(1);
    expect(seen?.aborted).toBe(true);
  });

  it("getProduct: 404 → null; handle được encode", async () => {
    const fetchMock = vi.fn(async () => ok({ code: "NOT_FOUND" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getProduct("a/b?c")).toBeNull();
    const calls = fetchMock.mock.calls as unknown as [string][];
    expect(calls[0]![0]).toBe("http://backend.test:9000/store/x/products/a%2Fb%3Fc");
  });

  it("getMenuCategories: lỗi nguồn → danh sách rỗng, không ném", async () => {
    vi.stubGlobal("fetch", async () => new Response("x", { status: 500 }));
    expect(await getMenuCategories()).toEqual([]);
  });

  const real = (name: string): unknown =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`./__fixtures__/backend/${name}.json`, import.meta.url)), "utf8"),
    );

  it("menu lấy từ /store/x/categories: chỉ nhóm gốc; getCategoryName tra cả nhóm con; không có → null", async () => {
    const fetchMock = vi.fn(async () => ok(real("categories")));
    vi.stubGlobal("fetch", fetchMock);
    const menu = await getMenuCategories();
    expect(menu.length).toBeGreaterThan(0);
    const calls = fetchMock.mock.calls as unknown as [string][];
    expect(new URL(calls[0]![0]).pathname).toBe("/store/x/categories");
    expect(menu.every((m) => ["nu", "nam", "giay", "phu-kien"].includes(m.handle))).toBe(true);
    expect(await getCategoryName("ao-nu")).toBe("Áo nữ");
    expect(await getCategoryName("khong-co")).toBeNull();
  });

  it("danh mục > 200: đọc theo offset tới count (trang 200) — danh mục thứ 201+ vẫn tra được tên", async () => {
    const total = 250;
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url);
      const limit = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset"));
      const categories = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
        handle: `dm-${offset + i}`,
        name: `Danh mục ${offset + i}`,
        parent_handle: null,
        product_count: 1,
      }));
      return ok({ categories, count: total, limit, offset });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCategoryName("dm-249")).toBe("Danh mục 249");
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([x]) => new URL(x).search);
    expect(urls).toEqual(["?limit=200&offset=0", "?limit=200&offset=200"]);
  });

  it("trang danh mục là ảnh chụp lệch nhau (thêm danh mục giữa hai trang) → không trùng handle", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      // Trang 2 lấy sau khi có thêm một danh mục đứng trước biên → dm-199 lặp lại ở đầu trang 2.
      const from = offset === 0 ? 0 : 199;
      const n = offset === 0 ? 200 : 51;
      const categories = Array.from({ length: n }, (_, i) => ({
        handle: `dm-${from + i}`,
        name: `Danh mục ${from + i}`,
        parent_handle: null,
        product_count: 1,
      }));
      return ok({ categories, count: offset === 0 ? 250 : 251, limit: 200, offset });
    });
    vi.stubGlobal("fetch", fetchMock);
    const all = await getCategories();
    const handles = all.map((c) => c.handle);
    expect(new Set(handles).size).toBe(handles.length);
    expect(handles).toContain("dm-249");
  });

  it("phản hồi thật của danh sách/chi tiết/tìm kiếm đi qua lớp ánh xạ", async () => {
    vi.stubGlobal("fetch", async () => ok(real("list")));
    const l = await listProducts(EMPTY_FILTER);
    expect(l.items[0]!.thumbnail.url).toBe("http://backend.test:9000/static/demo/den.svg?view=front");
    vi.stubGlobal("fetch", async () => ok(real("product")));
    const p = await getProduct("ao-so-mi-lua");
    expect(p?.options.size.map((x) => x.value)).toEqual(["s", "m"]);
    vi.stubGlobal("fetch", async () => ok(real("search-empty")));
    expect((await search(f("q=zzzzqq"))).suggestions?.[0]?.type).toBe("category");
  });
});
