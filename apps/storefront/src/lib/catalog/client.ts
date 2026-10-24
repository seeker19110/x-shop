import { EMPTY_FILTER, serializeFilter, type CatalogFilter } from "@x-shop/domain";
import { cache } from "react";
import { categoryName, NAV_CATEGORIES } from "../content/navigation";
import { mapCategories, mapList, mapProduct, mapSearch, type CategoryEntry } from "./backend-map";
import { getClientEnv, getServerEnv, resolveDataSource } from "../env";
import { fixtureList, fixtureProduct, fixtureSearch } from "./source-fixtures";
import { CatalogError, type ProductDetail, type ProductListResponse, type SearchResponse } from "./types";

/**
 * Client catalog phía server (không import vào client component): chọn nguồn bằng `XS_DATA_SOURCE`.
 * Backend: `fetch` server-side, dữ liệu công khai cache 60 giây (`next.revalidate`).
 */

/** Số sản phẩm mỗi trang ở storefront (backend cho phép tới 48). */
export const CATALOG_PAGE_SIZE = 12;

const TIMEOUT_MS = 5000;

interface ListOptions {
  category?: string | null;
  pageSize?: number;
}

async function backendGet<T>(path: string, params?: URLSearchParams, fresh = false): Promise<T> {
  const base = getServerEnv().MEDUSA_BACKEND_URL;
  const qs = params && params.size > 0 ? `?${params.toString()}` : "";
  let res: Response;
  try {
    res = await fetch(`${base}${path}${qs}`, {
      headers: {
        accept: "application/json",
        "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: 60 } }),
    });
  } catch {
    throw new CatalogError("UNAVAILABLE", "Không kết nối được máy chủ dữ liệu.");
  }
  if (res.ok) return (await res.json()) as T;
  let problem: { code?: string; detail?: string } = {};
  try {
    problem = (await res.json()) as typeof problem;
  } catch {
    // thân không phải JSON: dùng thông báo chung bên dưới
  }
  if (res.status === 404) throw new CatalogError("NOT_FOUND", problem.detail ?? "Không tìm thấy.", 404);
  if (res.status === 422) {
    const code = problem.code === "INVALID_RANGE" ? "INVALID_RANGE" : "VALIDATION";
    throw new CatalogError(code, problem.detail ?? "Tham số không hợp lệ.", 422);
  }
  throw new CatalogError("UNAVAILABLE", "Máy chủ dữ liệu đang gặp sự cố.", res.status);
}

function backendBase(): string {
  return getServerEnv().MEDUSA_BACKEND_URL;
}

function listParams(filter: CatalogFilter, opts: ListOptions): URLSearchParams {
  const p = new URLSearchParams(serializeFilter(filter));
  if (opts.category) p.set("category", opts.category);
  p.set("page_size", String(opts.pageSize ?? CATALOG_PAGE_SIZE));
  return p;
}

export async function listProducts(
  filter: CatalogFilter,
  opts: ListOptions = {},
): Promise<ProductListResponse> {
  if (resolveDataSource() === "fixtures") {
    if (filter.priceMin !== null && filter.priceMax !== null && filter.priceMin > filter.priceMax) {
      throw new CatalogError("INVALID_RANGE", "Giá thấp nhất lớn hơn giá cao nhất.", 422);
    }
    return fixtureList(filter, { category: opts.category, pageSize: opts.pageSize ?? CATALOG_PAGE_SIZE });
  }
  return mapList(await backendGet<unknown>("/store/x/products", listParams(filter, opts)), backendBase());
}

export async function search(
  filter: CatalogFilter,
  opts: { pageSize?: number } = {},
): Promise<SearchResponse> {
  if (resolveDataSource() === "fixtures") {
    if (filter.priceMin !== null && filter.priceMax !== null && filter.priceMin > filter.priceMax) {
      throw new CatalogError("INVALID_RANGE", "Giá thấp nhất lớn hơn giá cao nhất.", 422);
    }
    return fixtureSearch(filter, { pageSize: opts.pageSize ?? CATALOG_PAGE_SIZE });
  }
  return mapSearch(await backendGet<unknown>("/store/x/search", listParams(filter, opts)), backendBase());
}

/** `null` khi không có hoặc chưa publish (404). Bọc `cache` để `generateMetadata` và trang dùng chung một lần gọi. */
export const getProduct = cache(async (handle: string): Promise<ProductDetail | null> => {
  if (resolveDataSource() === "fixtures") return fixtureProduct(handle);
  try {
    const raw = await backendGet<unknown>(`/store/x/products/${encodeURIComponent(handle)}`);
    return mapProduct(raw, backendBase());
  } catch (e) {
    if (e instanceof CatalogError && e.code === "NOT_FOUND") return null;
    throw e;
  }
});

/**
 * Như `getProduct` nhưng KHÔNG cache — cho giỏ/thêm vào giỏ cần giá và tồn hiện hành (đặc tả §7.4: "kiểm tra lại khi
 * checkout"). `null` = không còn bán; lỗi nguồn → ném `CatalogError` để nơi gọi quyết định.
 */
export async function getProductFresh(handle: string): Promise<ProductDetail | null> {
  if (resolveDataSource() === "fixtures") return fixtureProduct(handle);
  try {
    const raw = await backendGet<unknown>(`/store/x/products/${encodeURIComponent(handle)}`, undefined, true);
    return mapProduct(raw, backendBase());
  } catch (e) {
    if (e instanceof CatalogError && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

export interface MenuCategory {
  handle: string;
  name: string;
}

/**
 * Mọi danh mục có sản phẩm. Backend: `GET /store/x/categories` (D-008). Fixtures: danh mục cấu hình có hàng.
 * Lỗi nguồn → danh sách rỗng (header/trang danh mục vẫn dựng được, không 500).
 */
export const getCategories = cache(async (): Promise<CategoryEntry[]> => {
  if (resolveDataSource() === "backend") {
    try {
      return mapCategories(await backendGet<unknown>("/store/x/categories"));
    } catch {
      return [];
    }
  }
  const checks = await Promise.all(
    NAV_CATEGORIES.map(async (c): Promise<CategoryEntry | null> => {
      try {
        const r = await listProducts(EMPTY_FILTER, { category: c.handle, pageSize: 1 });
        return r.total > 0
          ? { handle: c.handle, name: c.name, parent_handle: null, product_count: r.total }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((c): c is CategoryEntry => c !== null);
});

/** Menu: nhóm gốc có sản phẩm (đặc tả §3.3), lấy từ dữ liệu — không còn danh sách cứng ở nguồn backend. */
export const getMenuCategories = cache(async (): Promise<MenuCategory[]> =>
  (await getCategories())
    .filter((c) => c.parent_handle === null)
    .map(({ handle, name }) => ({ handle, name })),
);

/** Tên danh mục theo handle, `null` nếu không có (404). Backend: từ endpoint; fixtures: cấu hình tĩnh. */
export async function getCategoryName(handle: string): Promise<string | null> {
  if (resolveDataSource() === "fixtures") return categoryName(handle);
  return (await getCategories()).find((c) => c.handle === handle)?.name ?? null;
}
