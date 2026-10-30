import { ADDRESS_REVALIDATE_S } from "../cache-policy";
import { getClientEnv, getServerEnv, resolveDataSource } from "../env";
import { fetchWithRetry } from "../http/retry";

/**
 * Danh mục tỉnh/thành → phường/xã 2 cấp (CHK03). Chỉ dùng ở SERVER. Nguồn: backend
 * `GET /store/x/addresses/provinces[/:code/wards]` (cache công khai dài, dữ liệu đổi theo bản phát hành). Không đọc
 * thẳng từ `@x-shop/domain` vì domain nạp dữ liệu bằng `readFileSync(new URL())`, không chạy được khi bị Next đóng gói;
 * không có backend (fixtures) thì giỏ cũng tắt nên không cần danh mục.
 */
export interface Province {
  code: string;
  name: string;
}
export interface Ward {
  code: string;
  name: string;
}

type Fetched<T> = { status: "ok"; body: T } | { status: "not_found" } | { status: "unavailable" };

/**
 * Chạy ở SERVER (render) → `fetchWithRetry` (không phải clientFetch). GET công khai, idempotent: hạn 5 s mỗi lần, retry
 * lỗi tạm thời đúng 1 lần với backoff ngắn (SSR không được treo lâu) — xấu nhất ≈ 2 × 5 s + ≤ 0,5 s.
 */
const ADDRESS_TIMEOUT_MS = 5000;
const ADDRESS_MAX_RETRIES = 1;
/**
 * Phường/xã được client gọi qua route `/api/address/wards` — client ĐÃ retry có backoff (clientFetch); retry thêm ở
 * server sẽ nhân tải (4 × 2 lần gọi backend) nên ở đây chỉ đặt hạn, không retry.
 */
const WARDS_MAX_RETRIES = 0;
const ADDRESS_MAX_DELAY_MS = 500;

async function backendJson<T>(path: string, maxRetries: number): Promise<Fetched<T>> {
  try {
    const res = await fetchWithRetry(
      `${getServerEnv().MEDUSA_BACKEND_URL}${path}`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
        },
        next: { revalidate: ADDRESS_REVALIDATE_S },
      },
      { timeoutMs: ADDRESS_TIMEOUT_MS, maxRetries, maxDelayMs: ADDRESS_MAX_DELAY_MS },
    );
    if (res.ok) return { status: "ok", body: (await res.json()) as T };
    return res.status === 404 ? { status: "not_found" } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function getProvinces(): Promise<Province[]> {
  if (resolveDataSource() === "fixtures") return [];
  const r = await backendJson<{ provinces?: Province[] }>(
    "/store/x/addresses/provinces",
    ADDRESS_MAX_RETRIES,
  );
  return r.status === "ok" && Array.isArray(r.body.provinces)
    ? r.body.provinces.map(({ code, name }) => ({ code, name }))
    : [];
}

/**
 * `not_found`: mã tỉnh sai/không có (route trả 404, client KHÔNG thử lại). `unavailable`: nguồn lỗi/không có backend
 * (route trả 503, client thử lại có backoff). Tách hai trường hợp để retry chỉ chạy với lỗi tạm thời.
 */
export type WardsResult =
  { status: "ok"; wards: Ward[] } | { status: "not_found" } | { status: "unavailable" };

export async function getWards(provinceCode: string): Promise<WardsResult> {
  if (!/^[0-9]{1,10}$/.test(provinceCode)) return { status: "not_found" };
  if (resolveDataSource() === "fixtures") return { status: "not_found" };
  const r = await backendJson<{ wards?: Ward[] }>(
    `/store/x/addresses/provinces/${encodeURIComponent(provinceCode)}/wards`,
    WARDS_MAX_RETRIES,
  );
  if (r.status !== "ok") return r;
  const list = Array.isArray(r.body.wards) ? r.body.wards : [];
  return list.length > 0
    ? { status: "ok", wards: list.map(({ code, name }) => ({ code, name })) }
    : { status: "not_found" };
}
