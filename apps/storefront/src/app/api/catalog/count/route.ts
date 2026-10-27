import { parseFilter } from "@x-shop/domain";
import { CATALOG_API_CACHE_CONTROL } from "../../../../lib/cache-policy";
import { rateLimitedResponse } from "../../../../lib/catalog/rate-limited";
import { getCategoryName, listProducts } from "../../../../lib/catalog/client";

/**
 * Đếm kết quả cho nút "Xem N sản phẩm" của drawer lọc (nháp chưa áp dụng). Công khai, chỉ trả `{ total }`.
 * Tham số sai → 422 (client giữ nhãn trung tính); backend giới hạn tốc độ → 429 + Retry-After; nguồn dữ liệu lỗi → 503.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const { filter, issues } = parseFilter(params);
  const category = params.get("category");
  if (issues.length > 0 || (category !== null && (await getCategoryName(category)) === null)) {
    return Response.json({ total: null }, { status: 422 });
  }
  try {
    const r = await listProducts({ ...filter, page: 1 }, { category, pageSize: 1 });
    return Response.json({ total: r.total }, { headers: { "Cache-Control": CATALOG_API_CACHE_CONTROL } });
  } catch (e) {
    return rateLimitedResponse(e, { total: null }) ?? Response.json({ total: null }, { status: 503 });
  }
}
