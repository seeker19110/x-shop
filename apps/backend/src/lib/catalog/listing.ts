import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import {
  PAGE_SIZE_MAX,
  parseFilter,
  serializeFilter,
  slugify,
  variantMatches,
  type CatalogFilter,
  type FacetName,
  isNonEmpty,
} from "@x-shop/domain";
import { CATALOG_INDEX_MODULE } from "../../modules/catalog-index";
import type { Scope } from "../../modules/catalog-index/query";
import type CatalogIndexModuleService from "../../modules/catalog-index/service";
import type { CatalogIndexRow } from "../../modules/catalog-index/service";
import type { ProblemError } from "../http/problem";

export const PAGE_SIZE_DEFAULT = 24;

/** Header cache công khai ngắn cho dữ liệu catalog công khai (đặc tả §7.4) — CDN giữ 60 giây, phục vụ cũ tối đa 5 phút. */
export const PUBLIC_CATALOG_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/**
 * Trần số danh mục đọc từ Product Module cho menu/gợi ý (XC-PERF-006): cây danh mục do nhân viên quản lý, thực tế vài chục;
 * không bao giờ đọc "tất cả" (`take: null`). Chạm trần → ghi cảnh báo, phần ngoài trần (theo rank) không hiển thị.
 */
export const CATEGORY_FETCH_MAX = 1000;

/** Trang của GET /store/x/categories: mặc định = trần 200 (menu/sitemap đọc một trang là đủ); lớn hơn bị kẹp. */
export const CATEGORY_PAGE = { limitDefault: 200, limitMax: 200, offsetMax: CATEGORY_FETCH_MAX } as const;

type CategoryField = "id" | "handle" | "name" | "parent_category_id" | "rank";

/** Danh mục đang hoạt động, không nội bộ — tối đa CATEGORY_FETCH_MAX dòng theo rank; `onCap` khi có thể còn dòng ngoài trần. */
export async function listStoreCategories(
  scope: MedusaContainer,
  select: CategoryField[],
  onCap: (max: number) => void,
) {
  const rows = await scope
    .resolve(Modules.PRODUCT)
    .listProductCategories(
      { is_active: true, is_internal: false },
      { select, take: CATEGORY_FETCH_MAX + 1, order: { rank: "ASC", handle: "ASC" } },
    );
  if (rows.length > CATEGORY_FETCH_MAX) onCap(CATEGORY_FETCH_MAX);
  return rows.slice(0, CATEGORY_FETCH_MAX);
}

export interface ListingRequest {
  filter: CatalogFilter;
  category: string | null;
  pageSize: number;
}

type RawQuery = Record<string, unknown>;

/** Chỉ giữ giá trị chuỗi (qs có thể sinh object lồng nhau từ `a[b]=c` — bỏ qua như tham số lạ). */
export function sanitizeQuery(q: RawQuery): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(q)) {
    const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
    if (vals.length) out[k] = vals;
  }
  return out;
}

/** Đọc tham số danh sách theo allowlist (parseFilter) + `category`, `page_size`. Lỗi → danh sách cho 422. */
export function parseListingQuery(raw: RawQuery): { request: ListingRequest; errors: ProblemError[] } {
  const src = sanitizeQuery(raw);
  const { filter, issues } = parseFilter(src);
  const errors: ProblemError[] = issues.map((i) => ({ param: i.param, reason: i.reason }));
  let pageSize = PAGE_SIZE_DEFAULT;
  const ps = src.page_size?.[0];
  if (ps !== undefined) {
    // Lớn hơn trần (kể cả 10⁶ hay 16 chữ số) → kẹp về PAGE_SIZE_MAX (quy ước Store, lib/http/pagination.ts).
    if (/^\d{1,16}$/.test(ps) && Number(ps) >= 1) pageSize = Math.min(Number(ps), PAGE_SIZE_MAX);
    else errors.push({ param: "page_size", reason: "phải là số nguyên dương" });
  }
  const catRaw = src.category?.[0];
  let category: string | null = null;
  if (catRaw !== undefined && catRaw.trim() !== "") {
    category = slugify(catRaw);
    if (category === "" || category.length > 80) errors.push({ param: "category", reason: "không hợp lệ" });
  }
  return { request: { filter, category, pageSize }, errors };
}

export interface ListingItem {
  product_id: string;
  handle: string;
  title: string;
  /** Giá thấp/cao nhất trong các SKU KHỚP bộ lọc (S-202) — card hiện "Từ X" khi khác nhau. */
  price_min: number;
  price_max: number;
  /** Giá gạch của SKU rẻ nhất trong các SKU khớp, chỉ khi lớn hơn giá bán. */
  compare_at: number | null;
  colors: { value: string; label: string; hex: string | null }[];
  thumbnail: string | null;
  in_stock: boolean;
}

export interface FacetOut {
  value: string;
  label: string;
  count: number;
  hex?: string | null;
}

export interface ListingResponse {
  items: ListingItem[];
  facets: Record<FacetName, FacetOut[]>;
  total: number;
  page: number;
  page_size: number;
  /** Chuỗi query chuẩn hoá (thứ tự cố định, bỏ mặc định) — dùng làm URL chuẩn/khoá cache. */
  filter: string;
  category: string | null;
}

const FACETS: FacetName[] = ["color", "size", "material"];

function asIndexedVariant(r: CatalogIndexRow) {
  return {
    variantId: r.variant_id,
    sku: r.sku,
    color: r.color ?? "",
    size: r.size ?? "",
    price: r.price,
    inStock: r.in_stock,
  };
}

function itemOf(
  rows: CatalogIndexRow[],
  page: { product_id: string; price_min: number; price_max: number; in_stock: boolean },
  f: CatalogFilter,
): ListingItem {
  const first = rows[0] as CatalogIndexRow;
  const matched = rows.filter((r) => variantMatches(asIndexedVariant(r), f));
  const cheapest = matched.filter((r) => r.price === page.price_min);
  const compare = cheapest.map((r) => r.compare_at).filter((c): c is number => c !== null);
  const colors = new Map<string, { value: string; label: string; hex: string | null; rank: number }>();
  for (const r of rows) {
    if (isNonEmpty(r.color) && !colors.has(r.color))
      colors.set(r.color, {
        value: r.color,
        label: r.color_label ?? r.color,
        hex: r.color_hex,
        rank: r.color_rank ?? 9999,
      });
  }
  return {
    product_id: page.product_id,
    handle: first.handle,
    title: first.title,
    price_min: page.price_min,
    price_max: page.price_max,
    compare_at: compare.length ? Math.max(...compare) : null,
    colors: [...colors.values()]
      .sort((a, b) => a.rank - b.rank || (a.value < b.value ? -1 : 1))
      .map(({ value, label, hex }) => ({ value, label, hex })),
    thumbnail: f.colors.length ? (matched[0]?.thumbnail ?? first.product_thumbnail) : first.product_thumbnail,
    in_stock: page.in_stock,
  };
}

/** Danh sách + facet cùng SKU từ read model (S-201, S-202, CAT02–04). */
export async function runListing(
  container: MedusaContainer,
  channelIds: string[],
  req: ListingRequest,
): Promise<ListingResponse> {
  const index: CatalogIndexModuleService = container.resolve(CATALOG_INDEX_MODULE);
  const scope: Scope = { channelIds, category: req.category };
  const f = req.filter;
  // Một câu lệnh cho trang + tổng + 3 facet (T-058) — trước là 4 câu song song, mỗi câu quét lại phạm vi.
  const page = await index.listing(scope, f, req.pageSize);
  const ids = page.items.map((i) => i.product_id);
  const rows = ids.length ? await index.listRows({ channelIds, category: null }, ids) : [];
  const byProduct = new Map<string, CatalogIndexRow[]>();
  for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);
  const facets = Object.fromEntries(
    FACETS.map((facet) => [
      facet,
      page.facets[facet].map((v) => ({
        value: v.value,
        label: v.label ?? v.value,
        count: v.count,
        ...(facet === "color" ? { hex: v.extra } : {}),
      })),
    ]),
  ) as Record<FacetName, FacetOut[]>;
  return {
    items: page.items
      .filter((p) => byProduct.has(p.product_id))
      .map((p) => itemOf(byProduct.get(p.product_id)!, p, f)),
    facets,
    total: page.total,
    page: f.page,
    page_size: req.pageSize,
    filter: serializeFilter(f),
    category: req.category,
  };
}
