import { EMPTY_FILTER, serializeFilter, type CatalogFilter } from "@x-shop/domain";
import { cache } from "react";
import { categoryName, NAV_CATEGORIES } from "../content/navigation";
import { mapCategories, mapList, mapProduct, mapSearch, type CategoryEntry } from "./backend-map";
import { getClientEnv, getServerEnv, resolveDataSource } from "../env";
import { CATALOG_REVALIDATE_S } from "../cache-policy";
import { clientIpHeader } from "../security/client-ip";
import { fixtureList, fixtureProduct, fixtureSearch } from "./source-fixtures";
import { CatalogError, type ProductDetail, type ProductListResponse, type SearchResponse } from "./types";
import { isNonEmpty } from "../presence";
import { LIST_TAGS, productTags } from "./revalidate";

/**
 * Client catalog phía server (không import vào client component): chọn nguồn bằng `XS_DATA_SOURCE`.
 * Backend: `fetch` server-side, dữ liệu công khai cache `CATALOG_REVALIDATE_S` giây (`next.revalidate`, docs/ops/CACHE.md)
 * và gắn tag (`next.tags`) để webhook của backend hết hạn ngay khi sản phẩm/giá/tồn đổi (T-142, `/api/revalidate`):
 * danh sách/tìm kiếm/danh mục = `LIST_TAGS`, PDP = `productTags(handle)`.
 */

/** Số sản phẩm mỗi trang ở storefront (backend cho phép tới 48). */
export const CATALOG_PAGE_SIZE = 12;

const TIMEOUT_MS = 5000;

interface ListOptions {
  category?: string | null;
  pageSize?: number;
}

async function backendGet<T>(
  path: string,
  params?: URLSearchParams,
  fresh = false,
  extraHeaders: Record<string, string> = {},
  tags: readonly string[] = LIST_TAGS,
): Promise<T> {
  const base = getServerEnv().MEDUSA_BACKEND_URL;
  const qs = params && params.size > 0 ? `?${params.toString()}` : "";
  let res: Response;
  try {
    res = await fetch(`${base}${path}${qs}`, {
      headers: {
        accept: "application/json",
        "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(fresh
        ? { cache: "no-store" as const }
        : { next: { revalidate: CATALOG_REVALIDATE_S, tags: [...tags] } }),
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
  if (res.status === 429) {
    // Backend giới hạn tốc độ (vd. tìm kiếm theo IP): giữ nguyên 429 + Retry-After để route chuyển tiếp cho client,
    // tránh biến thành 503 "tạm thời" rồi bị retry làm tăng tải đúng lúc đang bị giới hạn.
    const raw = res.headers.get("retry-after")?.trim() ?? "";
    throw new CatalogError(
      "UNAVAILABLE",
      "Quá nhiều yêu cầu, thử lại sau.",
      429,
      /^\d{1,9}$/.test(raw) ? Number(raw) : null,
    );
  }
  throw new CatalogError("UNAVAILABLE", "Máy chủ dữ liệu đang gặp sự cố.", res.status);
}

function backendBase(): string {
  return getServerEnv().MEDUSA_BACKEND_URL;
}

function listParams(filter: CatalogFilter, opts: ListOptions): URLSearchParams {
  const p = new URLSearchParams(serializeFilter(filter));
  if (isNonEmpty(opts.category)) p.set("category", opts.category);
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
  // Tìm kiếm bị giới hạn theo IP khách ở backend (SEC03): chuyển tiếp IP (khi tin proxy) — khoá cache dữ liệu vì vậy
  // tách theo IP, chấp nhận được vì truy vấn tìm kiếm vốn phân tán.
  return mapSearch(
    await backendGet<unknown>("/store/x/search", listParams(filter, opts), false, await clientIpHeader()),
    backendBase(),
  );
}

/** `null` khi không có hoặc chưa publish (404). Bọc `cache` để `generateMetadata` và trang dùng chung một lần gọi. */
export const getProduct = cache(async (handle: string): Promise<ProductDetail | null> => {
  if (resolveDataSource() === "fixtures") return fixtureProduct(handle);
  try {
    const raw = await backendGet<unknown>(
      `/store/x/products/${encodeURIComponent(handle)}`,
      undefined,
      false,
      {},
      productTags(handle),
    );
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

/**
 * GET /store/x/categories phân trang (T-121): mỗi trang tối đa 200 (backend kẹp), tổng tối đa 1000 (CATEGORY_FETCH_MAX của
 * backend). Đọc lần lượt theo `offset` tới `count` — danh mục thứ 201 trở đi vẫn có trong menu/sitemap/trang danh mục.
 */
export const CATEGORY_PAGE_SIZE = 200;
const CATEGORY_TOTAL_MAX = 1000;

async function fetchAllCategories(): Promise<CategoryEntry[]> {
  // Mỗi trang cache riêng (revalidate 60 s) nên các trang có thể là ảnh chụp ở thời điểm khác nhau: danh mục vừa có/hết hàng
  // làm lệch biên trang → bỏ trùng theo handle (mục bị đẩy qua biên chỉ thiếu tới khi cache trang đồng bộ, ≤ một chu kỳ).
  const byHandle = new Map<string, CategoryEntry>();
  for (let offset = 0; offset < CATEGORY_TOTAL_MAX;) {
    const params = new URLSearchParams({ limit: String(CATEGORY_PAGE_SIZE), offset: String(offset) });
    const raw = await backendGet<unknown>("/store/x/categories", params);
    const page = mapCategories(raw);
    for (const c of page) if (!byHandle.has(c.handle)) byHandle.set(c.handle, c);
    const meta = (raw ?? {}) as { count?: unknown; limit?: unknown };
    const limit = typeof meta.limit === "number" && meta.limit > 0 ? meta.limit : CATEGORY_PAGE_SIZE;
    const total = typeof meta.count === "number" ? meta.count : offset + page.length;
    offset += limit;
    if (page.length < limit || offset >= total) break;
  }
  return [...byHandle.values()];
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
      return await fetchAllCategories();
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
