import { ADDRESS_REVALIDATE_S } from "../cache-policy";
import { getClientEnv, getServerEnv, resolveDataSource } from "../env";

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

async function backendJson<T>(path: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(`${getServerEnv().MEDUSA_BACKEND_URL}${path}`, {
      headers: {
        accept: "application/json",
        "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
      },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: ADDRESS_REVALIDATE_S },
    });
    if (res.ok) return { status: "ok", body: (await res.json()) as T };
    return res.status === 404 ? { status: "not_found" } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function getProvinces(): Promise<Province[]> {
  if (resolveDataSource() === "fixtures") return [];
  const r = await backendJson<{ provinces?: Province[] }>("/store/x/addresses/provinces");
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
  );
  if (r.status !== "ok") return r;
  const list = Array.isArray(r.body.wards) ? r.body.wards : [];
  return list.length > 0
    ? { status: "ok", wards: list.map(({ code, name }) => ({ code, name })) }
    : { status: "not_found" };
}
