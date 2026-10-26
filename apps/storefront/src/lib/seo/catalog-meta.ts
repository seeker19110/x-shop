import { activeFilterCount, type CatalogFilter } from "@x-shop/domain";
import type { Metadata } from "next";
import { hrefFor, totalPages } from "../../components/catalog/filter-state";

/**
 * Chính sách index (đặc tả §12.1): chỉ trang danh mục gốc (kể cả các trang phân trang của nó) được index.
 * Mọi URL có điều kiện lọc, sắp xếp khác mặc định, hoặc là trang tìm kiếm → `noindex,follow`
 * (không disallow trong robots để bot còn đọc được noindex).
 */
export function isIndexable(filter: CatalogFilter, opts: { search?: boolean } = {}): boolean {
  return opts.search !== true && activeFilterCount(filter) === 0 && filter.sort === "newest";
}

export interface CatalogMetaInput {
  basePath: string;
  filter: CatalogFilter;
  title: string;
  description: string;
  total: number | null;
  pageSize: number;
  search?: boolean;
}

export function catalogMetadata(input: CatalogMetaInput): Metadata {
  const { basePath, filter, search } = input;
  // URL chuẩn: tham số đã chuẩn hóa/sắp thứ tự (serializeFilter) — mọi cách viết cùng bộ lọc về một canonical.
  const canonical = hrefFor(basePath, filter);
  const last = input.total === null ? filter.page : totalPages(input.total, input.pageSize);
  const prev = filter.page > 1 ? hrefFor(basePath, { ...filter, page: filter.page - 1 }) : null;
  const next = filter.page < last ? hrefFor(basePath, { ...filter, page: filter.page + 1 }) : null;
  const indexable = isIndexable(filter, { search });
  return {
    title: filter.page > 1 ? `${input.title} – Trang ${filter.page}` : input.title,
    description: input.description,
    alternates: { canonical },
    robots: indexable ? { index: true, follow: true } : { index: false, follow: true },
    pagination: { previous: prev, next },
  };
}
