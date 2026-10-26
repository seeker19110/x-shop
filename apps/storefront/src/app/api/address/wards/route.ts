import { ADDRESS_API_CACHE_CONTROL } from "../../../../lib/cache-policy";
import { getWards } from "../../../../lib/checkout/address";

/**
 * Phường/xã của một tỉnh cho form thanh toán (`?province=01`). Dữ liệu công khai, cache dài (đổi theo bản phát hành).
 * Mã sai/không có → 404; nguồn lỗi cũng 404 (client hiện "không tải được" và cho thử lại).
 */
export async function GET(request: Request): Promise<Response> {
  const province = new URL(request.url).searchParams.get("province") ?? "";
  const wards = await getWards(province);
  if (wards === null) return Response.json({ wards: [] }, { status: 404 });
  return Response.json({ wards }, { headers: { "Cache-Control": ADDRESS_API_CACHE_CONTROL } });
}
