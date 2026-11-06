import { ADDRESS_API_CACHE_CONTROL } from "../../../../lib/cache-policy";
import { getWards } from "../../../../lib/checkout/address";

/**
 * Phường/xã của một tỉnh cho form thanh toán (`?province=01`). Dữ liệu công khai, cache dài (đổi theo bản phát hành).
 * Mã sai/không có → 404 (client không thử lại); nguồn lỗi → 503 (lỗi tạm thời: client thử lại có backoff, không cache).
 */
export async function GET(request: Request): Promise<Response> {
  const province = new URL(request.url).searchParams.get("province") ?? "";
  const r = await getWards(province);
  if (r.status === "not_found") return Response.json({ wards: [] }, { status: 404 });
  if (r.status === "unavailable") return Response.json({ wards: [] }, { status: 503 });
  return Response.json({ wards: r.wards }, { headers: { "Cache-Control": ADDRESS_API_CACHE_CONTROL } });
}
