import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createPriceListsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import {
  EMPTY_FILTER,
  facetCounts,
  filterProducts,
  parseFilter,
  serializeFilter,
  SORTS,
  type CatalogFilter,
  type FacetName,
  type IndexedProduct,
} from "@x-shop/domain";
import { CURRENCY } from "../../src/lib/catalog/constants";
import {
  CATALOG_INDEX_LOCK,
  DRAIN_JOB_WAIT_MS,
  drainCatalogIndex,
  markExpiredPrices,
  rebuildCatalogIndex,
  syncCatalogProducts,
} from "../../src/lib/catalog/indexer";
import { acquireOrdered, releaseOwned } from "../../src/lib/checkout/locks";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import { facetSql, listingSql, pageSql, type Scope, type Sql } from "../../src/modules/catalog-index/query";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { DEMO_CATEGORIES, DEMO_COLORS, DEMO_PRODUCTS, DEMO_SIZES } from "../../src/scripts/catalog-demo-data";
import seedCatalog, { type CatalogSeedResult } from "../../src/scripts/seed-catalog";
import { setProductFashionWorkflow } from "../../src/workflows/fashion/set-product-fashion";
import { storeHeaders } from "../helpers/auth";
import { createTestProduct } from "../helpers/catalog";

jest.setTimeout(300 * 1000);

type Res = {
  status: number;
  data: Record<string, unknown> & { [k: string]: never };
  headers: Record<string, string>;
};
type Item = { product_id: string; handle: string; price_min: number; price_max: number; in_stock: boolean };
type Facet = { value: string; label: string; count: number; hex?: string | null };

const CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/** PRNG xác định (mulberry32) — bộ lọc "ngẫu nhiên" lặp lại được giữa các lần chạy. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chờ read model hội tụ — giới hạn 60 giây = mục tiêu độ trễ đồng bộ của đặc tả §7.4. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  let last: T = await fn();
  while (!ok(last)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`Hết thời gian chờ; giá trị cuối: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 300));
    last = await fn();
  }
  return last;
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let seed: CatalogSeedResult;
    let headers: Record<string, string>;
    /** Dữ liệu cho oracle dựng ĐỘC LẬP từ dữ liệu demo (không đọc read model). */
    let oracleProducts: (IndexedProduct & { category: string; handle: string })[];

    const get = (path: string) => api.get(path, { headers }) as Promise<Res>;
    const getErr = (path: string, h: Record<string, string> = headers) =>
      api.get(path, { headers: h }).then(
        () => {
          throw new Error(`${path} lẽ ra phải lỗi`);
        },
        (e: { response: Res }) => e.response,
      );
    const list = async (qs: string) =>
      (await get(`/store/x/products?${qs}`)).data as unknown as {
        items: Item[];
        facets: Record<FacetName, Facet[]>;
        total: number;
        page: number;
        page_size: number;
        filter: string;
      };

    beforeAll(async () => {
      container = getContainer();
      seed = await seedCatalog({ container });
      const created = await container
        .resolve(Modules.PRODUCT)
        .listProducts({ id: Object.values(seed.products) }, { select: ["id", "created_at"] });
      const createdAt = new Map(created.map((p) => [p.id, new Date(p.created_at).toISOString()]));
      oracleProducts = DEMO_PRODUCTS.map((d) => {
        const id = seed.products[d.handle] as string;
        const catName = DEMO_CATEGORIES.find((c) => c.handle === d.category)?.name ?? "";
        return {
          productId: id,
          handle: d.handle,
          category: d.category,
          // search_text = tên + SKU + tên danh mục → oracle nhận cùng văn bản qua title.
          title: `${d.title} ${catName}`,
          material: d.material[0],
          createdAt: createdAt.get(id) as string,
          variants: d.variants.map(([color, size, price, stock]) => ({
            variantId: `${d.sku}-${color}-${size}`,
            sku: `${d.sku}-${color}-${size}`.toUpperCase(),
            color,
            size,
            price,
            inStock: stock > 0,
          })),
        };
      });
      headers = await storeHeaders(container);
    });

    const idOf = (handle: string) => seed.products[handle] as string;
    const inScope = (category: string | null) =>
      oracleProducts.filter(
        (p) =>
          category === null ||
          p.category === category ||
          DEMO_CATEGORIES.find((c) => c.handle === p.category)?.parent === category,
      );

    function expectMatchesOracle(
      res: Awaited<ReturnType<typeof list>>,
      f: CatalogFilter,
      category: string | null,
      pageSize: number,
    ) {
      const products = inScope(category);
      const expected = filterProducts(products, f);
      expect(res.total).toBe(expected.length);
      const slice = expected.slice((f.page - 1) * pageSize, f.page * pageSize);
      expect(res.items.map((i) => [i.product_id, i.price_min, i.price_max])).toEqual(
        slice.map((m) => [m.productId, m.priceMin, m.priceMax]),
      );
      for (const facet of ["color", "size", "material"] as FacetName[]) {
        const got = Object.fromEntries(res.facets[facet].map((v) => [v.value, v.count]));
        expect({ facet, counts: got }).toEqual({
          facet,
          counts: Object.fromEntries(facetCounts(products, f, facet)),
        });
      }
    }

    describe("lọc cùng SKU (S-201, S-202)", () => {
      it("AT01: đen-S + trắng-M không khớp đen-M; facet không đếm sản phẩm đó", async () => {
        const res = await list("color=den&size=m");
        expect(res.items.map((i) => i.handle)).not.toContain("ao-thun-gan-tam");
        expect(res.items.map((i) => i.handle)).toContain("ao-so-mi-lua");
        // Bỏ điều kiện size (facet size với color=den): sản phẩm chỉ được đếm cho size "s".
        const tee = oracleProducts.find((p) => p.handle === "ao-thun-gan-tam")!;
        const sizeM = res.facets.size.find((v) => v.value === "m")!.count;
        const withoutTee = facetCounts(
          oracleProducts.filter((p) => p !== tee),
          { ...EMPTY_FILTER, colors: ["den"], sizes: ["m"] },
          "size",
        ).get("m");
        expect(sizeM).toBe(withoutTee);
        expectMatchesOracle(res, parseFilter(new URLSearchParams("color=den&size=m")).filter, null, 24);
      });

      it("AT31: đen-M 700k ≤ 500k không khớp; bỏ giá trần → giá 700k của SKU khớp, sort theo 700k", async () => {
        const capped = await list("color=den&size=m&price_max=500000");
        expect(capped.items.map((i) => i.handle)).not.toContain("ao-so-mi-lua");
        const open = await list("color=den&size=m&sort=price_asc");
        const shirt = open.items.find((i) => i.handle === "ao-so-mi-lua")!;
        expect([shirt.price_min, shirt.price_max]).toEqual([700_000, 700_000]);
        expectMatchesOracle(
          open,
          parseFilter(new URLSearchParams("color=den&size=m&sort=price_asc")).filter,
          null,
          24,
        );
        // Không lọc: card hiện khoảng giá theo mọi SKU (300k–700k).
        const all = await list("q=ao%20so%20mi%20lua");
        const any = all.items.find((i) => i.handle === "ao-so-mi-lua")!;
        expect([any.price_min, any.price_max]).toEqual([300_000, 700_000]);
      });

      it("khớp oracle filterProducts/facetCounts trên 40 bộ lọc sinh ngẫu nhiên (seed cố định)", async () => {
        const rand = rng(20261024);
        const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
        const some = <T>(xs: readonly T[], max: number) => {
          const n = Math.floor(rand() * (max + 1));
          return [...new Set(Array.from({ length: n }, () => pick(xs)))];
        };
        const materials = [...new Set(DEMO_PRODUCTS.map((d) => d.material[0]))];
        const queries = [
          "ao",
          "quan",
          "so mi",
          "ÁO SƠ MI",
          "lua",
          "jean",
          "da",
          "giay",
          "tnam",
          "váy",
          "ao nam",
          "xyz",
        ];
        const categories = ["nu", "ao-nu", "nam", "quan-nam", "giay", "phu-kien", "tui"];
        let nonEmpty = 0;
        for (let i = 0; i < 40; i++) {
          const params = new URLSearchParams();
          for (const c of some(
            DEMO_COLORS.map((x) => x.value),
            2,
          ))
            params.append("color", c);
          for (const s of some(
            DEMO_SIZES.map((x) => x.value),
            2,
          ))
            params.append("size", s);
          for (const m of some(materials, 1)) params.append("material", m);
          let min = rand() < 0.3 ? pick([0, 200_000, 300_000, 450_000, 600_000]) : null;
          let max = rand() < 0.4 ? pick([250_000, 400_000, 500_000, 700_000, 1_000_000, 1_500_000]) : null;
          if (min !== null && max !== null && min > max) [min, max] = [max, min];
          if (min !== null) params.set("price_min", String(min));
          if (max !== null) params.set("price_max", String(max));
          if (rand() < 0.3) params.set("in_stock", "1");
          params.set("sort", pick(SORTS));
          if (rand() < 0.35) params.set("q", pick(queries));
          if (rand() < 0.2) params.set("page", "2");
          const category = rand() < 0.3 ? pick(categories) : null;
          const f = parseFilter(params).filter;
          const qs = `${serializeFilter(f)}&page_size=6${category ? `&category=${category}` : ""}`;
          const res = await list(qs);
          expectMatchesOracle(res, f, category, 6);
          if (res.total > 0) nonEmpty++;
        }
        // Bộ lọc phải đủ đa dạng: phần lớn có kết quả, không phải 40 lần so "rỗng = rỗng".
        expect(nonEmpty).toBeGreaterThanOrEqual(20);
      });

      it("không lọc → mới nhất trước; phân trang; trang vượt tổng → rỗng nhưng giữ tổng", async () => {
        const p1 = await list("page_size=10");
        expect(p1.total).toBe(DEMO_PRODUCTS.length);
        expect(p1.items).toHaveLength(10);
        expectMatchesOracle(p1, EMPTY_FILTER, null, 10);
        const far = await list("page=99&page_size=10");
        expect(far.items).toEqual([]);
        expect(far.total).toBe(DEMO_PRODUCTS.length);
        const clamp = await list("page_size=1000");
        expect(clamp.page_size).toBe(48);
      });

      it("tham số lặp được dedupe, tham số lạ bị bỏ, URL chuẩn hoá", async () => {
        const res = await list("size=m&size=M&foo=bar&color=trang,den&sort=bogus");
        expect(res.filter).toBe("color=den%2Ctrang&size=m");
      });

      it("danh mục cha gồm sản phẩm của danh mục con", async () => {
        const res = await list("category=nu&page_size=48");
        expect(res.total).toBe(inScope("nu").length);
        expect(res.items.map((i) => i.handle)).toEqual(
          expect.arrayContaining(["ao-so-mi-lua", "dam-suong-linen"]),
        );
        expect(res.items.map((i) => i.handle)).not.toContain("ao-polo-nam");
      });
    });

    describe("một câu lệnh cho trang + facet (T-058)", () => {
      /** Chạy cả bản tham chiếu (pageSql + 3 facetSql) và listingSql trên cùng DB, chuẩn hoá về cùng dạng JSON. */
      async function both(scope: Scope, f: CatalogFilter, pageSize: number) {
        const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        const run = async (q: Sql) =>
          (await db.raw(q.sql, q.bindings as never[])).rows as Record<string, unknown>[];
        const page = (await run(pageSql(scope, f, pageSize)))[0] as Record<string, unknown>;
        const reference = {
          total: page.total,
          items: page.items,
          color: await run(facetSql(scope, f, "color")),
          size: await run(facetSql(scope, f, "size")),
          material: await run(facetSql(scope, f, "material")),
        };
        const one = (await run(listingSql(scope, f, pageSize)))[0] as Record<string, unknown>;
        const single = {
          total: one.total,
          items: one.items,
          color: one.color,
          size: one.size,
          material: one.material,
        };
        return {
          reference: JSON.parse(JSON.stringify(reference)),
          single: JSON.parse(JSON.stringify(single)),
        };
      }

      it("kết quả y hệt bản tham chiếu 4 câu trên 120 bộ lọc (phạm vi, từ khoá ngắn/dài/SKU, trang sâu, biên giá)", async () => {
        const rand = rng(20261026);
        const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
        const materials = [...new Set(DEMO_PRODUCTS.map((d) => d.material[0]))];
        const queries = [
          "ao",
          "so mi",
          "ÁO SƠ MI",
          "lua",
          "jean",
          "smlua-den-m",
          "giay sneaker",
          "vay",
          "xyz",
          "100%",
          "a_b",
          "d",
        ];
        const categories = [null, null, "nu", "ao-nu", "nam", "quan-nam", "giay", "phu-kien", "khong-co"];
        const channelIds = [seed.base.salesChannelId];
        let nonEmpty = 0;
        for (let i = 0; i < 120; i++) {
          const params = new URLSearchParams();
          if (rand() < 0.5) params.append("color", pick(DEMO_COLORS.map((x) => x.value)));
          if (rand() < 0.2) params.append("color", pick(DEMO_COLORS.map((x) => x.value)));
          if (rand() < 0.4) params.append("size", pick(DEMO_SIZES.map((x) => x.value)));
          if (rand() < 0.2) params.append("material", pick(materials));
          if (rand() < 0.3) params.set("price_min", String(pick([0, 300_000, 450_000, 700_000])));
          if (rand() < 0.3) params.set("price_max", String(pick([300_000, 450_000, 700_000, 1_500_000])));
          if (rand() < 0.3) params.set("in_stock", "1");
          params.set("sort", pick(SORTS));
          if (rand() < 0.45) params.set("q", pick(queries));
          if (rand() < 0.25) params.set("page", String(pick([2, 3, 99])));
          const { filter: f, issues } = parseFilter(params);
          if (issues.length) continue; // price_min > price_max → 422 ở route, không tới truy vấn
          const scope: Scope = { channelIds, category: pick(categories) };
          const { reference, single } = await both(scope, f, pick([1, 6, 24, 48]));
          expect({ i, qs: params.toString(), category: scope.category, ...single }).toEqual({
            i,
            qs: params.toString(),
            category: scope.category,
            ...reference,
          });
          if ((reference.total as number) > 0) nonEmpty++;
        }
        expect(nonEmpty).toBeGreaterThanOrEqual(40);
      });

      it("kênh không có dữ liệu / nhiều kênh → giống bản tham chiếu (rỗng: total 0, facet [])", async () => {
        for (const channelIds of [["sc_khong_ton_tai"], [seed.base.salesChannelId, "sc_khong_ton_tai"]]) {
          const f = parseFilter(new URLSearchParams("q=ao&color=den")).filter;
          const { reference, single } = await both({ channelIds, category: null }, f, 24);
          expect(single).toEqual(reference);
        }
        const empty = await both({ channelIds: ["sc_khong_ton_tai"], category: null }, EMPTY_FILTER, 24);
        expect(empty.single).toEqual({ total: 0, items: [], color: [], size: [], material: [] });
      });

      it("20 listing đồng thời khi rebuild + sync: mỗi response nhất quán nội bộ (một snapshot cho trang và facet)", async () => {
        let busy = true;
        const writer = (async () => {
          while (busy) {
            await Promise.all([
              rebuildCatalogIndex(container),
              syncCatalogProducts(container, Object.values(seed.products).slice(0, 8)),
            ]);
          }
        })();
        try {
          const res = await Promise.all(
            Array.from({ length: 20 }, (_, i) => list(`page_size=${1 + (i % 6)}&sort=${SORTS[i % 3]}`)),
          );
          for (const r of res) {
            expect(r.total).toBe(DEMO_PRODUCTS.length);
            // Mỗi sản phẩm demo có đúng một chất liệu → tổng đếm facet chất liệu (không lọc) = tổng sản phẩm.
            expect(r.facets.material.reduce((n, v) => n + v.count, 0)).toBe(r.total);
          }
        } finally {
          busy = false;
          await writer;
        }
      });
    });

    describe("tìm kiếm (S-203)", () => {
      const search = async (q: string) =>
        (await get(`/store/x/search?q=${encodeURIComponent(q)}`)).data as unknown as {
          items: Item[];
          total: number;
          query: string | null;
          suggestions: { categories: { handle: string; name: string }[] };
        };

      it.each(["ao so mi", "ÁO SƠ MI", "so mi lua", "Áo Sơ Mi Lụa", "SMLUA-DEN-M", "smlua-trang-s"])(
        "'%s' tìm thấy Áo sơ mi lụa",
        async (q) => {
          const res = await search(q);
          expect(res.items.map((i) => i.handle)).toContain("ao-so-mi-lua");
        },
      );

      it("tìm theo tên danh mục; NFD = NFC", async () => {
        const byCat = await search("vay dam");
        expect(byCat.items.map((i) => i.handle)).toEqual(
          expect.arrayContaining(["dam-suong-linen", "dam-lua-hai-day"]),
        );
        const nfd = await search("Áo sơ mi".normalize("NFD"));
        const nfc = await search("Áo sơ mi");
        expect(nfd.items.map((i) => i.product_id)).toEqual(nfc.items.map((i) => i.product_id));
      });

      it("không kết quả → gợi ý danh mục; truy vấn > 100 ký tự bị cắt; q rỗng → mới nhất", async () => {
        const none = await search("qqqzzz");
        expect(none.total).toBe(0);
        expect(none.suggestions.categories.length).toBeGreaterThan(0);
        const related = await search("ao khoac zzz");
        expect(related.total).toBe(0);
        expect(related.suggestions.categories.map((c) => c.handle)).toEqual(
          expect.arrayContaining(["ao-nu", "ao-nam"]),
        );
        const long = await search(`ao ${"x".repeat(300)}`);
        expect((long.query ?? "").length).toBeLessThanOrEqual(100);
        const empty = await search("");
        expect(empty.total).toBe(DEMO_PRODUCTS.length);
        expect(empty.query).toBeNull();
      });
    });

    describe("hợp đồng HTTP", () => {
      it("header cache công khai ngắn ở danh sách, tìm kiếm, chi tiết", async () => {
        for (const path of ["/store/x/products", "/store/x/search?q=ao", "/store/x/products/ao-so-mi-lua"]) {
          const res = await get(path);
          expect(res.status).toBe(200);
          expect(res.headers["cache-control"]).toBe(CACHE);
          expect(res.headers["vary"]).toMatch(/x-publishable-api-key/i);
        }
      });

      it.each([
        ["price_min=600000&price_max=500000", "price_min"],
        ["price_min=abc", "price_min"],
        ["price_max=1.5", "price_max"],
        ["page=0", "page"],
        ["page_size=abc", "page_size"],
      ])("%s → 422 problem+json", async (qs, param) => {
        const res = await getErr(`/store/x/products?${qs}`);
        expect(res.status).toBe(422);
        expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
        expect(res.data).toMatchObject({ status: 422, code: "INVALID_QUERY" });
        expect((res.data.errors as unknown as { param: string }[]).map((e) => e.param)).toContain(param);
      });

      it("thiếu publishable key → bị từ chối (Medusa)", async () => {
        const res = await getErr("/store/x/products", {});
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      });
    });

    describe("chi tiết sản phẩm (PDP)", () => {
      it("trả đúng biến thể, giá, tồn, ảnh theo màu, bảng size, thuộc tính", async () => {
        const res = await get("/store/x/products/ao-so-mi-lua");
        const d = res.data as unknown as Record<string, unknown> & {
          variants: {
            sku: string;
            color: string;
            size: string;
            price: number;
            compare_at: number | null;
            in_stock: boolean;
          }[];
          options: {
            colors: { value: string; label: string; hex: string }[];
            sizes: { value: string; label: string }[];
          };
          images: { url: string; alt: string; color: string; width: number; height: number }[];
          size_chart: { version: number; unit: string; rows: unknown[] };
          model_measurements: { image_set: string; height_cm: number }[];
        };
        expect(d).toMatchObject({
          product_id: idOf("ao-so-mi-lua"),
          handle: "ao-so-mi-lua",
          title: "Áo sơ mi lụa",
          kind: "apparel",
          attributes: { material: "Lụa", composition: "100% lụa tơ tằm", fit: "Suông", origin: "Việt Nam" },
          category: { handle: "ao-nu", name: "Áo nữ" },
        });
        const v = Object.fromEntries(d.variants.map((x) => [`${x.color}-${x.size}`, x]));
        expect(v["den-m"]).toMatchObject({
          sku: "SMLUA-DEN-M",
          price: 700_000,
          compare_at: null,
          in_stock: true,
        });
        expect(v["trang-s"]).toMatchObject({ price: 300_000, in_stock: true });
        expect(v["den-s"]).toMatchObject({ price: 650_000, in_stock: false });
        expect(d.options.colors).toEqual([
          { value: "den", label: "Đen", hex: "#1A1A1A" },
          { value: "trang", label: "Trắng", hex: "#FFFFFF" },
        ]);
        expect(d.options.sizes).toEqual([
          { value: "s", label: "S" },
          { value: "m", label: "M" },
        ]);
        expect(d.images).toHaveLength(6);
        expect(d.images.filter((i) => i.color === "den")).toHaveLength(3);
        expect(d.images[0]).toMatchObject({
          width: 800,
          height: 1000,
          alt: expect.stringContaining("Áo sơ mi lụa"),
        });
        expect(d.size_chart).toMatchObject({ version: 1, unit: "cm" });
        expect(d.size_chart.rows.length).toBe(5);
        expect(d.model_measurements).toEqual([expect.objectContaining({ image_set: "den", height_cm: 168 })]);
        expect(typeof d.updated_at).toBe("string");
      });

      it("không có / bản nháp → 404", async () => {
        expect((await getErr("/store/x/products/khong-ton-tai")).status).toBe(404);
        const draft = await createTestProduct(container, { salesChannelId: seed.base.salesChannelId });
        expect((await getErr(`/store/x/products/${draft.handle}`)).status).toBe(404);
      });
    });

    describe("đồng bộ read model", () => {
      const index = () => container.resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);

      it("sản phẩm draft không xuất hiện; publish → xuất hiện; về draft → biến mất", async () => {
        const p = await createTestProduct(container, {
          title: "Áo khoác dạ bản nháp",
          salesChannelId: seed.base.salesChannelId,
          variants: [{ color: "den", size: "onesize", price: 990_000 }],
          images: [["den", "Áo khoác màu đen"]],
        });
        const search = async () =>
          ((await get("/store/x/search?q=khoac%20da%20ban%20nhap")).data as unknown as { items: Item[] })
            .items;
        await syncCatalogProducts(container, [p.id]);
        expect(await search()).toEqual([]);
        await setProductFashionWorkflow(container).run({
          input: { product_id: p.id, attributes: { kind: "accessory" } },
        });
        await updateProductsWorkflow(container).run({
          input: { selector: { id: p.id }, update: { status: "published" } },
        });
        await eventually(search, (items) => items.some((i) => i.product_id === p.id));
        await updateProductsWorkflow(container).run({
          input: { selector: { id: p.id }, update: { status: "draft" } },
        });
        await eventually(search, (items) => items.length === 0);
      });

      it("đổi giá → index phản ánh (AT31 đảo chiều khi đen-M về 450k)", async () => {
        const [variant] = await container
          .resolve(Modules.PRODUCT)
          .listProductVariants({ sku: "SMLUA-DEN-M" }, { select: ["id"] });
        await updateProductVariantsWorkflow(container).run({
          input: {
            product_variants: [{ id: variant!.id, prices: [{ amount: 450_000, currency_code: CURRENCY }] }],
          },
        });
        const res = await eventually(
          () => list("color=den&size=m&price_max=500000"),
          (r) => r.items.some((i) => i.handle === "ao-so-mi-lua"),
        );
        expect(res.items.find((i) => i.handle === "ao-so-mi-lua")).toMatchObject({ price_min: 450_000 });
      });

      it("giá khuyến mãi (price list) → giá bán + giá gạch; hết hạn → về giá gốc", async () => {
        const [variant] = await container
          .resolve(Modules.PRODUCT)
          .listProductVariants({ sku: "POLO-TRANG-M" }, { select: ["id"] });
        const endsAt = new Date(Date.now() + 4000);
        await createPriceListsWorkflow(container).run({
          input: {
            price_lists_data: [
              // Kiểu khai báo của workflow lệch với dữ liệu thật mà Admin API truyền (title/type/prices…).
              {
                title: "Sale thử",
                description: "Giảm giá thử",
                type: "sale",
                status: "active",
                ends_at: endsAt.toISOString(),
                prices: [{ variant_id: variant!.id, amount: 299_000, currency_code: CURRENCY }],
              } as never,
            ],
          },
        });
        const onSale = await eventually(
          () =>
            get("/store/x/products/ao-polo-nam").then(
              (r) =>
                r.data as unknown as {
                  variants: { sku: string; price: number; compare_at: number | null }[];
                },
            ),
          (d) => d.variants.some((v) => v.sku === "POLO-TRANG-M" && v.price === 299_000),
        );
        expect(onSale.variants.find((v) => v.sku === "POLO-TRANG-M")).toMatchObject({ compare_at: 390_000 });
        const rows = await eventually(
          () =>
            index().listRows({ channelIds: [seed.base.salesChannelId], category: null }, [
              idOf("ao-polo-nam"),
            ]),
          (rs) => rs.some((r) => r.sku === "POLO-TRANG-M" && r.price === 299_000),
        );
        const row = rows.find((r) => r.sku === "POLO-TRANG-M")!;
        expect(row.compare_at).toBe(390_000);
        expect(new Date(row.price_valid_until as Date).getTime()).toBe(endsAt.getTime());
        // Hết hạn: job mỗi phút đánh dấu + xả; ở đây gọi trực tiếp đúng các hàm job dùng.
        await new Promise((r) => setTimeout(r, Math.max(0, endsAt.getTime() - Date.now() + 500)));
        expect(await markExpiredPrices(container)).toBeGreaterThanOrEqual(1);
        await drainCatalogIndex(container, { waitMs: DRAIN_JOB_WAIT_MS });
        const after = await index().listRows({ channelIds: [seed.base.salesChannelId], category: null }, [
          idOf("ao-polo-nam"),
        ]);
        expect(after.find((r) => r.sku === "POLO-TRANG-M")).toMatchObject({
          price: 390_000,
          compare_at: null,
          price_valid_until: null,
        });
      });

      it("đổi tồn → in_stock phản ánh (đen-40 hết → nhập 5)", async () => {
        const qs = "color=den&size=40&in_stock=1";
        expect((await list(qs)).items.map((i) => i.handle)).not.toContain("giay-sneaker-da-trang");
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const { data } = await query.graph({
          entity: "product_variant",
          fields: ["inventory_items.inventory_item_id"],
          filters: { sku: "SNKR-DEN-40" },
        });
        const itemId = (data[0] as { inventory_items: { inventory_item_id: string }[] }).inventory_items[0]!
          .inventory_item_id;
        await updateInventoryLevelsWorkflow(container).run({
          input: {
            updates: [
              { inventory_item_id: itemId, location_id: seed.base.sellableLocationId, stocked_quantity: 5 },
            ],
          },
        });
        await eventually(
          () => list(qs),
          (r) => r.items.some((i) => i.handle === "giay-sneaker-da-trang"),
        );
      });

      /**
       * T-137 — điều kiện tải đo được: khoá ghi index đang bị chủ KHÁC giữ (rebuild/sync dài, hoặc tiến trình khác dùng
       * chung Redis) đúng lúc có ghi. Trước sửa: lượt xả hẹn sau sự kiện thấy khoá bận → bỏ lượt, dấu nằm chờ job mỗi
       * phút (đo: 41 s; tới 60 s + thời gian giữ khoá). Sau sửa: lượt xả chờ khoá → hội tụ ngay khi khoá nhả.
       */
      describe("khoá index đang bị giữ khi có ghi (T-137)", () => {
        const HOLD_MS = 4_000;
        /** Biên sau khi nhả khoá — chặt hơn nhiều so với 60 s của §7.4 để phân biệt "kích ngay" với "chờ job phút". */
        const AFTER_RELEASE_MS = 10_000;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const locking = () => container.resolve(Modules.LOCKING);
        const holdForeign = async (ownerId: string) =>
          acquireOrdered(locking(), [CATALOG_INDEX_LOCK], {
            ownerId,
            waitMs: 30_000,
            ttlSeconds: 30,
            scope: "test-foreign",
          });
        const isDirty = async (productId: string) => {
          const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
          const res = await db.raw("SELECT 1 FROM catalog_index_dirty WHERE product_id = ?", [productId]);
          return (res.rows as unknown[]).length > 0;
        };
        const rowOf = async (sku: string, handle: string) =>
          (
            await index().listRows({ channelIds: [seed.base.salesChannelId], category: null }, [idOf(handle)])
          ).find((r) => r.sku === sku);
        /**
         * Job xả chạy ở giây :00 mỗi phút; cửa sổ [giữ khoá … nhả + biên] phải nằm gọn giữa hai nhịp để chỉ đường kích
         * ngay (không phải job) mới làm test xanh — nếu không, test có thể xanh giả trước khi sửa.
         */
        async function betweenCronTicks(windowMs: number): Promise<void> {
          for (;;) {
            const s = new Date().getSeconds();
            if (s >= 8 && s * 1000 + windowMs <= 57_000) return;
            await sleep(500);
          }
        }

        it("đổi giá khi khoá bận: index hội tụ ≤ 10 s sau khi khoá nhả (không chờ job mỗi phút)", async () => {
          const [variant] = await container
            .resolve(Modules.PRODUCT)
            .listProductVariants({ sku: "BLZNU-BE-M" }, { select: ["id"] });
          await betweenCronTicks(HOLD_MS + AFTER_RELEASE_MS);
          const owner = `test-foreign-${Date.now()}`;
          await holdForeign(owner);
          let released = 0;
          try {
            await updateProductVariantsWorkflow(container).run({
              input: {
                product_variants: [
                  { id: variant!.id, prices: [{ amount: 1_190_000, currency_code: CURRENCY }] },
                ],
              },
            });
            // Sự kiện đã tới subscriber (dấu bẩn có trong DB) và lượt xả hẹn sau nó đã chạy vào lúc khoá bận.
            await eventually(
              () => isDirty(idOf("ao-khoac-blazer-nu")),
              (d) => d,
              HOLD_MS,
            );
            await sleep(HOLD_MS);
            expect(await isDirty(idOf("ao-khoac-blazer-nu"))).toBe(true);
          } finally {
            await releaseOwned(locking(), owner, [CATALOG_INDEX_LOCK]);
            released = Date.now();
          }
          const row = await eventually(
            () => rowOf("BLZNU-BE-M", "ao-khoac-blazer-nu"),
            (r) => r?.price === 1_190_000,
            AFTER_RELEASE_MS,
          );
          expect(row?.price).toBe(1_190_000);
          expect(Date.now() - released).toBeLessThanOrEqual(AFTER_RELEASE_MS);
        });

        it("job xả gặp khoá bận: chờ khoá rồi xả trong cùng lượt (không bỏ lượt tới phút sau)", async () => {
          const [variant] = await container
            .resolve(Modules.PRODUCT)
            .listProductVariants({ sku: "VMIDI-XAM-S" }, { select: ["id"] });
          const owner = `test-foreign-${Date.now()}`;
          await holdForeign(owner);
          let job: Promise<number>;
          try {
            await updateProductVariantsWorkflow(container).run({
              input: {
                product_variants: [
                  { id: variant!.id, prices: [{ amount: 440_000, currency_code: CURRENCY }] },
                ],
              },
            });
            await eventually(
              () => isDirty(idOf("chan-vay-midi-xep-ly")),
              (d) => d,
              HOLD_MS,
            );
            // Đúng lời gọi của job mỗi phút: phải trả về SAU khi thay đổi đã vào index (tự xả hoặc lượt xả khác đã xả).
            job = drainCatalogIndex(container, { waitMs: DRAIN_JOB_WAIT_MS });
            await sleep(1_000);
          } finally {
            setTimeout(() => void releaseOwned(locking(), owner, [CATALOG_INDEX_LOCK]), 1_000);
          }
          await job!;
          expect((await rowOf("VMIDI-XAM-S", "chan-vay-midi-xep-ly"))?.price).toBe(440_000);
        });
      });

      it("rebuild đồng thời với đồng bộ: không trùng dòng; người đọc không thấy trạng thái nửa vời", async () => {
        const expectedRows = DEMO_PRODUCTS.reduce((n, d) => n + d.variants.length, 0);
        let reading = true;
        const totals: number[] = [];
        const reader = (async () => {
          while (reading) totals.push((await list("page_size=1")).total);
        })();
        await Promise.all([
          rebuildCatalogIndex(container),
          syncCatalogProducts(container, Object.values(seed.products).slice(0, 5)),
          rebuildCatalogIndex(container),
          syncCatalogProducts(container, Object.values(seed.products)),
        ]);
        reading = false;
        await reader;
        const rows = await index().listRows({ channelIds: [seed.base.salesChannelId], category: null });
        expect(rows).toHaveLength(expectedRows);
        expect(new Set(rows.map((r) => r.variant_id)).size).toBe(expectedRows);
        expect(totals.length).toBeGreaterThan(0);
        expect(new Set(totals)).toEqual(new Set([DEMO_PRODUCTS.length]));
      });
    });
  },
});
