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

const REVALIDATE_S = 24 * 60 * 60;

async function backendJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${getServerEnv().MEDUSA_BACKEND_URL}${path}`, {
      headers: {
        accept: "application/json",
        "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
      },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: REVALIDATE_S },
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function getProvinces(): Promise<Province[]> {
  if (resolveDataSource() === "fixtures") return [];
  const r = await backendJson<{ provinces?: Province[] }>("/store/x/addresses/provinces");
  return Array.isArray(r?.provinces) ? r.provinces.map(({ code, name }) => ({ code, name })) : [];
}

/** `null` khi mã tỉnh không tồn tại (404); danh sách rỗng khi nguồn lỗi cũng trả `null` để route trả 503/404 đúng. */
export async function getWards(provinceCode: string): Promise<Ward[] | null> {
  if (!/^[0-9]{1,10}$/.test(provinceCode)) return null;
  if (resolveDataSource() === "fixtures") return null;
  const r = await backendJson<{ wards?: Ward[] }>(
    `/store/x/addresses/provinces/${encodeURIComponent(provinceCode)}/wards`,
  );
  return Array.isArray(r?.wards) && r.wards.length > 0
    ? r.wards.map(({ code, name }) => ({ code, name }))
    : null;
}
