import { matchesQuery, normalizeQuery, slugify } from "./text.js";

export const SORTS = ["newest", "price_asc", "price_desc"] as const;
export type Sort = (typeof SORTS)[number];
export const PAGE_SIZE_MAX = 48;

/** Trạng thái lọc đã chuẩn hóa — nguồn duy nhất cho URL, chip và truy vấn (CAT02–03). */
export interface CatalogFilter {
  q: string | null;
  colors: string[];
  sizes: string[];
  materials: string[];
  priceMin: number | null;
  priceMax: number | null;
  inStock: boolean;
  sort: Sort;
  page: number;
}

export const EMPTY_FILTER: CatalogFilter = {
  q: null,
  colors: [],
  sizes: [],
  materials: [],
  priceMin: null,
  priceMax: null,
  inStock: false,
  sort: "newest",
  page: 1,
};

export type FilterParseIssue = { param: string; reason: string };

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function getAll(src: ParamSource, key: string): string[] {
  if (src instanceof URLSearchParams) return src.getAll(key);
  const v = src[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function slugList(values: string[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const s = slugify(part);
      if (s !== "" && s.length <= 40) out.add(s);
    }
  }
  return [...out].sort().slice(0, 20);
}

function parseMoney(raw: string | undefined, param: string, issues: FilterParseIssue[]): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d{1,12}$/.test(raw.trim())) {
    issues.push({ param, reason: "phải là số nguyên VND" });
    return null;
  }
  return Number(raw.trim());
}

/**
 * Đọc tham số URL theo allowlist: tham số lạ bị bỏ, giá trị trùng được dedupe và sắp xếp, số sai bị bỏ kèm issue.
 * `price_min > price_max` → issue `invalid_range` (API trả 422; UI giữ điều kiện và hiển thị lỗi).
 */
export function parseFilter(src: ParamSource): { filter: CatalogFilter; issues: FilterParseIssue[] } {
  const issues: FilterParseIssue[] = [];
  const priceMin = parseMoney(getAll(src, "price_min")[0], "price_min", issues);
  const priceMax = parseMoney(getAll(src, "price_max")[0], "price_max", issues);
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    issues.push({ param: "price_min", reason: "invalid_range" });
  }
  const sortRaw = getAll(src, "sort")[0];
  const sort = (SORTS as readonly string[]).includes(sortRaw ?? "") ? (sortRaw as Sort) : "newest";
  const pageRaw = getAll(src, "page")[0];
  let page = 1;
  if (pageRaw !== undefined) {
    if (/^\d{1,4}$/.test(pageRaw) && Number(pageRaw) >= 1) page = Number(pageRaw);
    else issues.push({ param: "page", reason: "phải là số nguyên dương" });
  }
  return {
    filter: {
      q: normalizeQuery(getAll(src, "q")[0]),
      colors: slugList(getAll(src, "color")),
      sizes: slugList(getAll(src, "size")),
      materials: slugList(getAll(src, "material")),
      priceMin,
      priceMax,
      inStock: getAll(src, "in_stock")[0] === "1",
      sort,
      page,
    },
    issues,
  };
}

/**
 * URL chuẩn: khóa theo thứ tự cố định, giá trị đã sắp, bỏ giá trị mặc định → cùng bộ lọc luôn ra cùng URL
 * (tránh URL trùng cho crawler — đặc tả §12.1). Trả chuỗi không có `?`.
 */
export function serializeFilter(f: CatalogFilter): string {
  const p = new URLSearchParams();
  if (f.q !== null) p.set("q", f.q);
  if (f.colors.length) p.set("color", [...f.colors].sort().join(","));
  if (f.sizes.length) p.set("size", [...f.sizes].sort().join(","));
  if (f.materials.length) p.set("material", [...f.materials].sort().join(","));
  if (f.priceMin !== null) p.set("price_min", String(f.priceMin));
  if (f.priceMax !== null) p.set("price_max", String(f.priceMax));
  if (f.inStock) p.set("in_stock", "1");
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

/** Số điều kiện đang áp (chip), không tính sort/page. */
export function activeFilterCount(f: CatalogFilter): number {
  return (
    f.colors.length +
    f.sizes.length +
    f.materials.length +
    (f.priceMin !== null || f.priceMax !== null ? 1 : 0) +
    (f.inStock ? 1 : 0) +
    (f.q !== null ? 1 : 0)
  );
}

export interface IndexedVariant {
  variantId: string;
  sku: string;
  color: string;
  size: string;
  /** Giá bán hiện hành, nguyên VND. */
  price: number;
  inStock: boolean;
}

export interface IndexedProduct {
  productId: string;
  title: string;
  material: string | null;
  createdAt: string;
  variants: IndexedVariant[];
}

/** Một SKU thỏa MỌI điều kiện cấp SKU — màu, size, giá, còn hàng phải đúng trên cùng SKU (AT01, AT31). */
export function variantMatches(v: IndexedVariant, f: CatalogFilter): boolean {
  if (f.colors.length && !f.colors.includes(v.color)) return false;
  if (f.sizes.length && !f.sizes.includes(v.size)) return false;
  if (f.priceMin !== null && v.price < f.priceMin) return false;
  if (f.priceMax !== null && v.price > f.priceMax) return false;
  if (f.inStock && !v.inStock) return false;
  return true;
}

export interface ProductMatch {
  productId: string;
  matchedVariantIds: string[];
  /** Giá hiển thị/sắp xếp lấy từ SKU khớp, không từ SKU khác của cùng sản phẩm. */
  priceMin: number;
  priceMax: number;
}

export function matchProduct(p: IndexedProduct, f: CatalogFilter): ProductMatch | null {
  if (f.materials.length && (p.material === null || !f.materials.includes(p.material))) return null;
  if (f.q !== null && !matchesQuery(`${p.title} ${p.variants.map((v) => v.sku).join(" ")}`, f.q)) return null;
  const matched = p.variants.filter((v) => variantMatches(v, f));
  if (matched.length === 0) return null;
  const prices = matched.map((v) => v.price);
  return {
    productId: p.productId,
    matchedVariantIds: matched.map((v) => v.variantId),
    priceMin: Math.min(...prices),
    priceMax: Math.max(...prices),
  };
}

/**
 * Bản tham chiếu (oracle) của truy vấn lọc — backend SQL phải trả cùng kết quả; test tích hợp so sánh hai bên.
 * Sắp xếp ổn định: giá rồi productId; "mới nhất" theo createdAt giảm dần rồi productId.
 */
export function filterProducts(products: readonly IndexedProduct[], f: CatalogFilter): ProductMatch[] {
  const byId = new Map(products.map((p) => [p.productId, p]));
  const out = products.map((p) => matchProduct(p, f)).filter((m): m is ProductMatch => m !== null);
  const tie = (a: ProductMatch, b: ProductMatch) => (a.productId < b.productId ? -1 : 1);
  if (f.sort === "price_asc") out.sort((a, b) => a.priceMin - b.priceMin || tie(a, b));
  else if (f.sort === "price_desc") out.sort((a, b) => b.priceMax - a.priceMax || tie(a, b));
  else {
    out.sort((a, b) => {
      const ca = byId.get(a.productId)?.createdAt ?? "";
      const cb = byId.get(b.productId)?.createdAt ?? "";
      return ca === cb ? tie(a, b) : ca < cb ? 1 : -1;
    });
  }
  return out;
}

export type FacetName = "color" | "size" | "material";

/**
 * Đếm facet kiểu disjunctive: số sản phẩm cho mỗi giá trị khi thay điều kiện của chính facet đó bằng giá trị này,
 * giữ nguyên các điều kiện khác — vẫn đòi khớp trên cùng SKU.
 */
export function facetCounts(
  products: readonly IndexedProduct[],
  f: CatalogFilter,
  facet: FacetName,
): Map<string, number> {
  const values = new Set<string>();
  for (const p of products) {
    if (facet === "material") {
      if (p.material !== null) values.add(p.material);
    } else for (const v of p.variants) values.add(facet === "color" ? v.color : v.size);
  }
  const counts = new Map<string, number>();
  for (const value of [...values].sort()) {
    const probe: CatalogFilter = {
      ...f,
      colors: facet === "color" ? [value] : f.colors,
      sizes: facet === "size" ? [value] : f.sizes,
      materials: facet === "material" ? [value] : f.materials,
    };
    counts.set(value, products.filter((p) => matchProduct(p, probe) !== null).length);
  }
  return counts;
}
