import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PAGE_SIZE_MAX } from "@x-shop/domain";
import { CATEGORY_FETCH_MAX, CATEGORY_PAGE, PAGE_SIZE_DEFAULT } from "../../src/lib/catalog/listing";
import { ADMIN_PAGE } from "../../src/lib/http/pagination";
import seedXShop from "../../src/scripts/seed";
import {
  createAdmin,
  createMfaAdmin,
  noThrow,
  storeHeaders,
  type AdminAccount,
  type HttpClient,
} from "../helpers/auth";

jest.setTimeout(600 * 1000);

/**
 * T-121 (XC-PERF-006) — mọi endpoint danh sách có `limit` mặc định + tối đa và phân trang; yêu cầu 10⁶ phần tử bị kẹp
 * (Store) hoặc từ chối 422 (Admin) — quy ước ở lib/http/pagination.ts và OpenAPI `components.parameters.Limit`.
 *
 * BẢNG PHÂN LOẠI mọi route GET tùy biến (`src/api/{store/x,admin/x,x}/**\/route.ts`): thêm route GET mới mà không phân
 * loại ở đây → test đỏ. Loại:
 *  - `admin`: `limit` 1–100 (mặc định 50) + `offset` 0–100.000, vượt khoảng → 422;
 *  - `store`: tham số kích thước trang lớn hơn trần bị kẹp, ≤ 0/không phải số → 422;
 *  - `parent`: danh sách con của MỘT đối tượng, bị chặn bởi bất biến của đối tượng cha (ghi lý do);
 *  - `static`: dữ liệu tham chiếu cố định theo bản phát hành;
 *  - `single`: không phải danh sách (chi tiết, tổng hợp, health, webhook);
 *  - `export`: xuất file toàn bộ theo thiết kế (ghi lý do).
 */
type Bound =
  | { kind: "admin"; url: string; key: string }
  | { kind: "store"; url: string; key: string; param: "limit" | "page_size"; def: number; max: number }
  | { kind: "parent" | "static" | "single" | "export"; why: string };

const ADMIN_LISTS: Record<string, { url: string; key: string }> = {
  "get /admin/x/audit": { url: "/admin/x/audit", key: "audit_logs" },
  "get /admin/x/refunds": { url: "/admin/x/refunds?state=requested", key: "refunds" },
  "get /admin/x/reports/exceptions": { url: "/admin/x/reports/exceptions", key: "items" },
  "get /admin/x/returns": { url: "/admin/x/returns", key: "returns" },
  "get /admin/x/settlements/batches": { url: "/admin/x/settlements/batches", key: "batches" },
  "get /admin/x/settlements/discrepancies": {
    url: "/admin/x/settlements/discrepancies",
    key: "discrepancies",
  },
  "get /admin/x/size-charts": { url: "/admin/x/size-charts", key: "size_charts" },
};

const GET_ROUTES: Record<string, Bound> = {
  ...Object.fromEntries(Object.entries(ADMIN_LISTS).map(([k, v]) => [k, { kind: "admin" as const, ...v }])),
  "get /store/x/products": {
    kind: "store",
    url: "/store/x/products",
    key: "items",
    param: "page_size",
    def: PAGE_SIZE_DEFAULT,
    max: PAGE_SIZE_MAX,
  },
  "get /store/x/search": {
    kind: "store",
    url: "/store/x/search?q=t121",
    key: "items",
    param: "page_size",
    def: PAGE_SIZE_DEFAULT,
    max: PAGE_SIZE_MAX,
  },
  "get /store/x/categories": {
    kind: "store",
    url: "/store/x/categories",
    key: "categories",
    param: "limit",
    def: CATEGORY_PAGE.limitDefault,
    max: CATEGORY_PAGE.limitMax,
  },
  "get /admin/x/settlements/batches/{id}": {
    kind: "parent",
    why: "dòng của MỘT batch — số dòng ≤ SETTLEMENT_CONFIG.maxRows (5.000) chặn lúc nhập CSV",
  },
  "get /admin/x/users/{id}/roles": {
    kind: "parent",
    why: "vai trò của MỘT user — tối đa 6 (CHECK user_role.role)",
  },
  "get /store/x/orders/{display_ref}/returns": {
    kind: "parent",
    why: "yêu cầu đổi/trả của MỘT đơn — dòng trả UNIQUE(return_id, dòng đơn), số lượng ≤ số đã mua",
  },
  "get /store/x/addresses/provinces": {
    kind: "static",
    why: "34 tỉnh/thành — dữ liệu tĩnh theo bản phát hành",
  },
  "get /store/x/addresses/provinces/{code}/wards": {
    kind: "static",
    why: "phường/xã của MỘT tỉnh — dữ liệu tĩnh theo bản phát hành",
  },
  "get /admin/x/exports/products.csv": {
    kind: "export",
    why: "xuất toàn catalog cùng định dạng nhập (vòng nhập/xuất) — đọc theo lô 100 sản phẩm; quyền catalog.read",
  },
  "get /admin/x/imports/{id}": { kind: "single", why: "chi tiết một job nhập" },
  "get /admin/x/products/{id}/publish-check": { kind: "single", why: "kết quả kiểm một sản phẩm" },
  "get /admin/x/reports/summary": { kind: "single", why: "số tổng hợp, không trả danh sách bản ghi" },
  "get /admin/x/returns/{id}": { kind: "single", why: "chi tiết một yêu cầu trả" },
  "get /store/x/checkout/attempts/{id}": { kind: "single", why: "trạng thái một lần checkout" },
  "get /store/x/orders/{display_ref}": { kind: "single", why: "chi tiết một đơn" },
  "get /store/x/products/{handle}": { kind: "single", why: "chi tiết một sản phẩm" },
  "get /x/health": { kind: "single", why: "liveness, không trả danh sách" },
  "get /x/readyz": { kind: "single", why: "readiness, không trả danh sách" },
  "get /x/webhooks/vnpay/ipn": { kind: "single", why: "IPN VNPAY (một giao dịch)" },
};

const API_DIR = join(__dirname, "../../src/api");
const SRC_DIR = join(__dirname, "../../src");

/** Mọi route GET trong cây route tùy biến (cùng cách quét với route-inventory.spec). */
function scanGetRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "route.ts") {
        const rel = relative(API_DIR, dirname(p)).split(sep).join("/");
        const src = readFileSync(p, "utf8");
        if (/export\s+(?:async\s+function|function|const)\s+GET\b/.test(src))
          out.push(`get /${rel.replace(/\[([^\]]+)\]/g, "{$1}")}`);
      }
    }
  };
  for (const root of ["store/x", "admin/x", "x"]) walk(join(API_DIR, root));
  return out.sort();
}

/**
 * `take: null` (đọc không giới hạn) còn lại trong mã chạy trên server — chỉ ở job nền/xuất file, không ở đường request
 * danh sách. Khoá: đường dẫn tương đối từ src/ → số lần xuất hiện; mỗi mục có lý do.
 */
const TAKE_NULL_ALLOWED: Record<string, { count: number; why: string }> = {
  "lib/catalog/indexer.ts": {
    count: 1,
    why: "job dựng lại read model: id mọi sản phẩm published, xử lý theo lô",
  },
  "lib/catalog/import.ts": {
    count: 1,
    why: "xuất CSV toàn catalog (GET exports/products.csv — loại export)",
  },
  "scripts/seed-catalog.ts": { count: 2, why: "seed dữ liệu demo chạy tay, không phải route" },
};

function scanTakeNull(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__tests__" && name !== "admin") walk(p);
      } else if (/\.ts$/.test(name)) {
        const n = (readFileSync(p, "utf8").match(/take:\s*null\s*[,}]/g) ?? []).length;
        if (n > 0) out[relative(SRC_DIR, p).split(sep).join("/")] = n;
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

type Res = { status: number; data: Record<string, unknown> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

const withParams = (url: string, params: Record<string, string>) => {
  const u = new URL(url, "http://x");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
};

/** Giá trị kích thước trang sai (≤ 0, không phải số nguyên, rỗng, số mũ, âm) — mọi loại → 422. */
const BAD_SIZES = ["0", "-1", "abc", "1.5", "", "1e3", " 5", "-0"];

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer, dbConnection }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let owner: AdminAccount;
    let store: Record<string, string>;

    const get = (url: string, headers: Record<string, string>) =>
      api.request({ method: "GET", url, headers, ...noThrow });
    const db = () =>
      dbConnection as unknown as {
        raw(sql: string, b?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
      };

    // Dữ liệu lớn dựng trong beforeAll cấp ngoài: test runner chụp DB mẫu sau beforeAll này và khôi phục trước MỖI test —
    // dữ liệu dựng ở beforeAll lồng sẽ bị xoá trước khi test chạy.
    const N_CATEGORIES = 230;
    const N_PRODUCTS = 70;
    const N_AUDIT = 260;
    const N_CHARTS = 130;

    beforeAll(async () => {
      container = getContainer();
      await seedXShop({ container });
      store = await storeHeaders(container);
      owner = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: ["owner"] });
      const channels = await container
        .resolve(Modules.SALES_CHANNEL)
        .listSalesChannels({}, { select: ["id"], take: 50 });
      const handles = Array.from({ length: N_CATEGORIES }, (_, i) => `t121-dm-${String(i).padStart(3, "0")}`);
      await container
        .resolve(Modules.PRODUCT)
        .createProductCategories(
          handles.map((handle, i) => ({ name: `T121 danh mục ${i}`, handle, is_active: true, rank: i })),
        );
      for (const ch of channels)
        await db().raw(
          `INSERT INTO catalog_variant_index (variant_id, sales_channel_id, product_id, handle, title, sku, search_text,
               category_handles, price, in_stock, created_at)
             SELECT 'variant_t121_' || g, ?, 'prod_t121_' || g, 't121-sp-' || g, 'T121 sản phẩm ' || g, 'T121-' || g,
                    't121 san pham ' || g, ARRAY(SELECT jsonb_array_elements_text(?::jsonb)), 100000 + g, true,
                    now() - g * interval '1 minute'
               FROM generate_series(1, ?) g`,
          [ch.id, JSON.stringify(handles), N_PRODUCTS],
        );
      await db().raw(
        `INSERT INTO audit_log (id, actor_type, action, resource_type, resource_id)
           SELECT 'audit_t121_' || lpad(g::text, 4, '0'), 'system', 't121.bulk', 'thing', 't' || g
             FROM generate_series(1, ?) g`,
        [N_AUDIT],
      );
      await db().raw(
        `INSERT INTO size_chart (id, code, version, name, garment_type, columns, rows)
           SELECT 'szc_t121_' || g, 't121-bang-' || lpad(g::text, 3, '0'), 1, 'Bảng ' || g, 'ao', '[]', '[]'
             FROM generate_series(1, ?) g`,
        [N_CHARTS],
      );
    });

    describe("bảng phân loại route GET", () => {
      it("mọi route GET tùy biến đã phân loại (route mới chưa phân loại → đỏ); lý do không rỗng", () => {
        expect(scanGetRoutes()).toEqual(Object.keys(GET_ROUTES).sort());
        for (const [route, b] of Object.entries(GET_ROUTES))
          if ("why" in b) expect({ route, ok: b.why.trim().length >= 10 }).toEqual({ route, ok: true });
      });

      it("không còn `take: null` trên đường request (chỉ job nền/xuất file trong allowlist)", () => {
        const found = scanTakeNull();
        expect(found).toEqual(
          Object.fromEntries(Object.entries(TAKE_NULL_ALLOWED).map(([f, v]) => [f, v.count])),
        );
      });
    });

    describe("danh sách Admin: limit 1–100 (mặc định 50), offset 0–100.000; vượt khoảng → 422, không kẹp", () => {
      const lists = Object.entries(ADMIN_LISTS);

      it.each(lists)("%s: mặc định limit 50 / offset 0; limit 100 được", async (_r, l) => {
        const res = await get(l.url, owner.headers);
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({ limit: ADMIN_PAGE.limitDefault, offset: 0 });
        expect(Array.isArray(res.data[l.key])).toBe(true);
        expect((res.data[l.key] as unknown[]).length).toBeLessThanOrEqual(ADMIN_PAGE.limitDefault);
        const max = await get(withParams(l.url, { limit: String(ADMIN_PAGE.limitMax) }), owner.headers);
        expect(max.status).toBe(200);
        expect(max.data.limit).toBe(ADMIN_PAGE.limitMax);
      });

      it.each(lists)("%s: limit 10⁶ / 101 / sai kiểu; offset âm / quá trần → 422", async (_r, l) => {
        const bad: Record<string, string>[] = [
          { limit: "1000000" },
          { limit: String(ADMIN_PAGE.limitMax + 1) },
          // " 5" không có ở đây: zod coerce của danh sách Admin chấp nhận khoảng trắng bao quanh (= 5).
          ...BAD_SIZES.filter((v) => v !== " 5").map((limit) => ({ limit })),
          { offset: "-1" },
          { offset: String(ADMIN_PAGE.offsetMax + 1) },
          { offset: "abc" },
        ];
        for (const params of bad) {
          const res = await get(withParams(l.url, params), owner.headers);
          expect({ params, status: res.status }).toEqual({ params, status: 422 });
        }
      });
    });

    describe("danh sách Store: kích thước trang lớn hơn trần bị kẹp; ≤ 0 / không phải số → 422", () => {
      const lists = Object.entries(GET_ROUTES).filter(
        (e): e is [string, Extract<Bound, { kind: "store" }>] => e[1].kind === "store",
      );

      it.each(lists)("%s: mặc định / 10⁶ / 16 chữ số bị kẹp về trần", async (_r, l) => {
        const sizeOf = (d: Record<string, unknown>) => (l.param === "limit" ? d.limit : d.page_size);
        const def = await get(l.url, store);
        expect(def.status).toBe(200);
        expect(sizeOf(def.data)).toBe(l.def);
        for (const v of ["1000000", "9999999999999999", String(l.max + 1)]) {
          const res = await get(withParams(l.url, { [l.param]: v }), store);
          expect({ v, status: res.status, size: sizeOf(res.data) }).toEqual({ v, status: 200, size: l.max });
          expect((res.data[l.key] as unknown[]).length).toBeLessThanOrEqual(l.max);
        }
      });

      it.each(lists)("%s: kích thước trang sai → 422 INVALID_QUERY", async (_r, l) => {
        for (const v of [...BAD_SIZES, "99999999999999999"]) {
          const res = await get(withParams(l.url, { [l.param]: v }), store);
          expect({ v, status: res.status, code: res.data.code }).toEqual({
            v,
            status: 422,
            code: "INVALID_QUERY",
          });
        }
      });

      it("trang catalog: page 0 / 5 chữ số / âm → 422; page 9999 hợp lệ (trang rỗng)", async () => {
        for (const page of ["0", "10000", "-1", "x"]) {
          const res = await get(withParams("/store/x/products", { page }), store);
          expect({ page, status: res.status }).toEqual({ page, status: 422 });
        }
        const last = await get(withParams("/store/x/products", { page: "9999" }), store);
        expect(last.status).toBe(200);
        expect(last.data.items).toEqual([]);
      });

      it("danh mục: offset âm / quá trần / mảng → 422", async () => {
        for (const q of [
          "offset=-1",
          `offset=${CATEGORY_FETCH_MAX + 1}`,
          "offset=a",
          "limit[]=5",
          "limit=5&limit=6",
        ]) {
          const res = await get(`/store/x/categories?${q}`, store);
          expect({ q, status: res.status }).toEqual({ q, status: 422 });
        }
      });
    });

    describe("dữ liệu lớn hơn trần một trang", () => {
      /** Duyệt hết các trang (song song khi `parallel`) → mọi phần tử đúng một lần. */
      async function collect(
        url: string,
        headers: Record<string, string>,
        key: string,
        id: (row: Record<string, unknown>) => string,
        pageSize: number,
        total: number,
        parallel = false,
      ): Promise<string[]> {
        const offsets = Array.from({ length: Math.ceil(total / pageSize) }, (_, i) => i * pageSize);
        const fetchPage = async (offset: number) => {
          const res = await get(
            withParams(url, { limit: String(pageSize), offset: String(offset) }),
            headers,
          );
          expect(res.status).toBe(200);
          const rows = res.data[key] as Record<string, unknown>[];
          expect(rows.length).toBeLessThanOrEqual(pageSize);
          return rows.map(id);
        };
        const pages = parallel
          ? await Promise.all(offsets.map(fetchPage))
          : await offsets.reduce<Promise<string[][]>>(
              async (acc, o) => [...(await acc), await fetchPage(o)],
              Promise.resolve([]),
            );
        return pages.flat();
      }

      it(`danh mục: ${N_CATEGORIES} danh mục có hàng → trang mặc định 200, limit 10⁶ kẹp 200, offset lấy phần còn lại`, async () => {
        const def = await get("/store/x/categories", store);
        expect(def.status).toBe(200);
        const count = def.data.count as number;
        expect(count).toBeGreaterThanOrEqual(N_CATEGORIES);
        expect((def.data.categories as unknown[]).length).toBe(CATEGORY_PAGE.limitMax);
        const huge = await get("/store/x/categories?limit=1000000", store);
        expect(huge.data).toMatchObject({ limit: CATEGORY_PAGE.limitMax, count });
        expect((huge.data.categories as unknown[]).length).toBe(CATEGORY_PAGE.limitMax);
        const rest = await get(`/store/x/categories?offset=${CATEGORY_PAGE.limitMax}`, store);
        expect((rest.data.categories as unknown[]).length).toBe(count - CATEGORY_PAGE.limitMax);
        const all = await collect(
          "/store/x/categories",
          store,
          "categories",
          (c) => String(c.handle),
          50,
          count,
          true,
        );
        expect(all).toHaveLength(count);
        expect(new Set(all).size).toBe(count);
        expect(all.filter((h) => h.startsWith("t121-dm-"))).toHaveLength(N_CATEGORIES);
      });

      it(`sản phẩm/tìm kiếm: ${N_PRODUCTS} sản phẩm → page_size 10⁶ kẹp ${PAGE_SIZE_MAX}; gợi ý danh mục tối đa 6`, async () => {
        const list = await get("/store/x/products?category=t121-dm-000&page_size=1000000", store);
        expect(list.status).toBe(200);
        expect(list.data).toMatchObject({ total: N_PRODUCTS, page_size: PAGE_SIZE_MAX });
        expect((list.data.items as unknown[]).length).toBe(PAGE_SIZE_MAX);
        const page2 = await get("/store/x/products?category=t121-dm-000&page_size=1000000&page=2", store);
        expect((page2.data.items as unknown[]).length).toBe(N_PRODUCTS - PAGE_SIZE_MAX);
        const search = await get("/store/x/search?q=t121&page_size=1000000", store);
        expect(search.data).toMatchObject({ total: N_PRODUCTS, page_size: PAGE_SIZE_MAX });
        const none = await get("/store/x/search?q=khongcogizzqq&page_size=1000000", store);
        expect(none.status).toBe(200);
        expect(none.data.total).toBe(0);
        expect(
          ((none.data.suggestions as { categories: unknown[] }).categories ?? []).length,
        ).toBeLessThanOrEqual(6);
      });

      it(`audit: ${N_AUDIT} dòng → limit 10⁶ bị từ chối, 100/trang, duyệt song song đủ mỗi dòng một lần`, async () => {
        const url = "/admin/x/audit?action=t121.bulk";
        expect((await get(withParams(url, { limit: "1000000" }), owner.headers)).status).toBe(422);
        const first = await get(url, owner.headers);
        expect(first.data).toMatchObject({ count: N_AUDIT, limit: 50 });
        expect((first.data.audit_logs as unknown[]).length).toBe(50);
        const ids = await collect(url, owner.headers, "audit_logs", (r) => String(r.id), 100, N_AUDIT, true);
        expect(ids).toHaveLength(N_AUDIT);
        expect(new Set(ids).size).toBe(N_AUDIT);
      });

      it(`bảng size: ${N_CHARTS} bảng hiện hành → mặc định 50/trang, count đủ, duyệt tuần tự đủ mỗi bảng một lần`, async () => {
        const first = await get("/admin/x/size-charts", owner.headers);
        expect(first.status).toBe(200);
        const count = first.data.count as number;
        expect(count).toBeGreaterThanOrEqual(N_CHARTS);
        expect((first.data.size_charts as unknown[]).length).toBe(ADMIN_PAGE.limitDefault);
        const codes = await collect(
          "/admin/x/size-charts",
          owner.headers,
          "size_charts",
          (r) => String(r.code),
          100,
          count,
        );
        expect(new Set(codes).size).toBe(count);
        expect(codes.filter((c) => c.startsWith("t121-bang-"))).toHaveLength(N_CHARTS);
        // Lọc theo code: mọi phiên bản của một bảng, vẫn có count/limit/offset.
        const one = await get("/admin/x/size-charts?code=t121-bang-001", owner.headers);
        expect(one.data).toMatchObject({ count: 1, limit: 50, offset: 0 });
        // Tham số lạ → 422 như mọi danh sách Admin.
        expect((await get("/admin/x/size-charts?foo=1", owner.headers)).status).toBe(422);
      });
    });

    describe("phân quyền danh sách bảng size (catalog.read)", () => {
      it("được phép: warehouse (catalog.read); bị từ chối: accountant, không vai trò — kể cả khi tham số sai (403 trước 422)", async () => {
        const warehouse = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["warehouse"],
        });
        const ok = await get("/admin/x/size-charts?limit=5", warehouse.headers);
        expect(ok.status).toBe(200);
        expect((ok.data.size_charts as unknown[]).length).toBeLessThanOrEqual(5);
        const accountant = await createAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const none = await createAdmin(rawApi as unknown as HttpClient, container, { roles: [] });
        for (const who of [accountant, none]) {
          expect((await get("/admin/x/size-charts?limit=5", who.headers)).status).toBe(403);
          expect((await get("/admin/x/size-charts?limit=1000000", who.headers)).status).toBe(403);
        }
        expect((await get("/admin/x/size-charts?limit=5", {})).status).toBe(401);
      });
    });
  },
});
