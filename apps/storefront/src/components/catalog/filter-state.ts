import { formatVnd, type CatalogFilter, type FilterParseIssue } from "@x-shop/domain";
import type { Facets } from "../../lib/catalog/types";
import { hrefFor } from "./filter-url";

export { hrefFor, withoutConditions } from "./filter-url";

/** Hàm thuần dựng chip/thông báo từ `CatalogFilter` (server). Phần URL dùng được ở client nằm ở `filter-url.ts`. */

/** Bỏ một điều kiện (chip) và về trang 1; khóa: `color:den` · `size:m` · `material:lua` · `price` · `in_stock` · `q`. */
export function withoutCondition(filter: CatalogFilter, key: string): CatalogFilter {
  const next: CatalogFilter = { ...filter, page: 1 };
  const [kind, value] = key.split(":");
  if (kind === "color") next.colors = filter.colors.filter((v) => v !== value);
  else if (kind === "size") next.sizes = filter.sizes.filter((v) => v !== value);
  else if (kind === "material") next.materials = filter.materials.filter((v) => v !== value);
  else if (kind === "price") {
    next.priceMin = null;
    next.priceMax = null;
  } else if (kind === "in_stock") next.inStock = false;
  else if (kind === "q") next.q = null;
  return next;
}

export interface FilterChip {
  key: string;
  label: string;
  href: string;
}

function labelOf(facet: Facets[keyof Facets] | undefined, value: string, fallback: string): string {
  return facet?.find((f) => f.value === value)?.label ?? fallback;
}

/** Điều kiện đang áp thành chip; mỗi chip có `href` tới URL chuẩn KHÔNG còn điều kiện đó. */
export function chipsFor(
  basePath: string,
  filter: CatalogFilter,
  facets: Facets | null | undefined,
  opts: { includeQuery?: boolean } = {},
): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: string, label: string) =>
    chips.push({ key, label, href: hrefFor(basePath, withoutCondition(filter, key)) });
  if (opts.includeQuery && filter.q !== null) add("q", `Từ khóa: ${filter.q}`);
  for (const v of filter.colors) add(`color:${v}`, `Màu: ${labelOf(facets?.color, v, v)}`);
  for (const v of filter.sizes) add(`size:${v}`, `Size: ${labelOf(facets?.size, v, v.toUpperCase())}`);
  for (const v of filter.materials) add(`material:${v}`, `Chất liệu: ${labelOf(facets?.material, v, v)}`);
  if (filter.priceMin !== null || filter.priceMax !== null) {
    const { priceMin: lo, priceMax: hi } = filter;
    add(
      "price",
      lo !== null && hi !== null
        ? `Giá: ${formatVnd(lo)} – ${formatVnd(hi)}`
        : lo !== null
          ? `Giá: từ ${formatVnd(lo)}`
          : `Giá: đến ${formatVnd(hi!)}`,
    );
  }
  if (filter.inStock) add("in_stock", "Còn hàng");
  return chips;
}

const PARAM_LABEL: Record<string, string> = {
  price_min: "Giá thấp nhất",
  price_max: "Giá cao nhất",
  page: "Số trang",
};

/** Câu báo lỗi nhẹ (tiếng Việt) cho tham số URL sai; trang vẫn hiển thị với phần hợp lệ. */
export function describeIssues(issues: readonly FilterParseIssue[]): string[] {
  return issues.map((i) =>
    i.reason === "invalid_range"
      ? "Giá thấp nhất đang lớn hơn giá cao nhất — hãy chỉnh lại khoảng giá."
      : `${PARAM_LABEL[i.param] ?? i.param} không hợp lệ (${i.reason}) — đã bỏ qua.`,
  );
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** Các mục phân trang: luôn có trang đầu/cuối và ±1 quanh trang hiện tại; `null` = dấu "…". */
export function pageWindow(current: number, last: number): Array<number | null> {
  const keep = new Set([1, last, current - 1, current, current + 1].filter((n) => n >= 1 && n <= last));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | null> = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}
