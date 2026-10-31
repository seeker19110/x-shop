/**
 * Một nơi khai báo TTL/Cache-Control của cache DỮ LIỆU CÔNG KHAI ở storefront (BE-CACHE-007). Chiến lược vô hiệu hoá của
 * từng loại cache và ngưỡng cũ tối đa: docs/ops/CACHE.md (test `cache-policy.test.ts` giữ tài liệu khớp mã).
 *
 * Lưu ý: `export const revalidate = 60` ở app/page.tsx phải là literal tĩnh (Next đọc lúc build) nên không import từ
 * đây; test giữ hai giá trị bằng nhau.
 */

/** TTL của `fetch` server-side tới backend cho dữ liệu catalog công khai (`next.revalidate`). */
export const CATALOG_REVALIDATE_S = 60;
/** TTL của danh mục tỉnh/phường (đổi theo bản phát hành dữ liệu hành chính). */
export const ADDRESS_REVALIDATE_S = 24 * 60 * 60;

/** `Cache-Control` của `/api/catalog/suggest` và `/api/catalog/count`. */
export const CATALOG_API_S_MAXAGE_S = 60;
export const CATALOG_API_SWR_S = 300;
export const CATALOG_API_CACHE_CONTROL = `public, s-maxage=${CATALOG_API_S_MAXAGE_S}, stale-while-revalidate=${CATALOG_API_SWR_S}`;

/** `Cache-Control` của `/api/address/wards` (khớp PUBLIC_ADDRESS_CACHE của backend). */
export const ADDRESS_API_MAX_AGE_S = 3600;
export const ADDRESS_API_S_MAXAGE_S = 86_400;
export const ADDRESS_API_SWR_S = 604_800;
export const ADDRESS_API_CACHE_CONTROL = `public, max-age=${ADDRESS_API_MAX_AGE_S}, s-maxage=${ADDRESS_API_S_MAXAGE_S}, stale-while-revalidate=${ADDRESS_API_SWR_S}`;

export interface CacheControlDirectives {
  maxAge: number | null;
  sMaxAge: number | null;
  staleWhileRevalidate: number | null;
  noStore: boolean;
  isPrivate: boolean;
}

/** Đọc các chỉ thị số/cờ của `Cache-Control`; chỉ thị thiếu → `null`/`false`; giá trị không phải số nguyên ≥ 0 → `null`. */
export function parseCacheControl(value: string): CacheControlDirectives {
  const out: CacheControlDirectives = {
    maxAge: null,
    sMaxAge: null,
    staleWhileRevalidate: null,
    noStore: false,
    isPrivate: false,
  };
  for (const part of value.split(",")) {
    const [rawName = "", rawValue] = part.trim().split("=");
    const name = rawName.trim().toLowerCase();
    const n = rawValue !== undefined && /^\d+$/.test(rawValue.trim()) ? Number(rawValue.trim()) : null;
    if (name === "max-age") out.maxAge = n;
    else if (name === "s-maxage") out.sMaxAge = n;
    else if (name === "stale-while-revalidate") out.staleWhileRevalidate = n;
    else if (name === "no-store") out.noStore = true;
    else if (name === "private") out.isPrivate = true;
  }
  return out;
}

/**
 * Trần "dữ liệu cũ" (giây) sau khi nguồn đổi, cho một API công khai đứng sau cache dữ liệu `originTtlS` của Next:
 * origin có thể trả bản tới `originTtlS` giây tuổi; CDN giữ tươi `s-maxage` rồi còn được phát bản cũ thêm
 * `stale-while-revalidate` trong lúc làm mới nền. `private`/`no-store` → chỉ còn tuổi của origin.
 */
export function maxStalenessS(cacheControl: string, originTtlS: number): number {
  const d = parseCacheControl(cacheControl);
  if (d.noStore || d.isPrivate) return originTtlS;
  const shared = d.sMaxAge ?? d.maxAge ?? 0;
  return originTtlS + shared + (d.staleWhileRevalidate ?? 0);
}
