import { parseFilter, type CatalogFilter, type FilterParseIssue } from "@x-shop/domain";
import { cache } from "react";
import { t } from "../i18n";
import { listProducts, search } from "./client";
import { CatalogError, type ProductListResponse, type SearchSuggestion } from "./types";

export type RawParams = Record<string, string | string[] | undefined>;

/** `searchParams` của Next → chuỗi truy vấn ổn định (khóa cache theo giá trị, không theo tham chiếu). */
export function toQueryString(params: RawParams): string {
  const qs = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) qs.append(key, item);
  }
  return qs.toString();
}

export interface Listing {
  filter: CatalogFilter;
  issues: FilterParseIssue[];
  result: ProductListResponse | null;
  error: string | null;
  suggestions: SearchSuggestion[];
}

function messageFor(e: unknown): string {
  if (e instanceof CatalogError) {
    if (e.code === "INVALID_RANGE") return t("catalog.listingError.invalidRange");
    if (e.code === "VALIDATION") return t("catalog.listingError.validation");
  }
  return t("catalog.listingError.unavailable");
}

/**
 * Đọc URL → `parseFilter` → dữ liệu. Không bao giờ ném lỗi dữ liệu ra ngoài: tham số sai/nguồn lỗi trả `result: null`
 * kèm thông báo nhẹ, điều kiện lọc vẫn giữ nguyên để người dùng sửa (không 500).
 */
export const loadListing = cache(
  async (kind: "category" | "search", category: string, qs: string): Promise<Listing> => {
    const { filter, issues } = parseFilter(new URLSearchParams(qs));
    const rangeBroken = issues.some((i) => i.reason === "invalid_range");
    if (rangeBroken) {
      return {
        filter,
        issues,
        result: null,
        error: t("catalog.listingError.invalidRange"),
        suggestions: [],
      };
    }
    try {
      if (kind === "search" && filter.q !== null) {
        const r = await search(filter);
        return { filter, issues, result: r, error: null, suggestions: r.suggestions ?? [] };
      }
      const r = await listProducts(filter, { category: kind === "category" ? category : null });
      return { filter, issues, result: r, error: null, suggestions: [] };
    } catch (e) {
      return { filter, issues, result: null, error: messageFor(e), suggestions: [] };
    }
  },
);
