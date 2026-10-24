import { parseFilter } from "@x-shop/domain";
import { getCategoryName, listProducts } from "../../../../lib/catalog/client";

/**
 * Đếm kết quả cho nút "Xem N sản phẩm" của drawer lọc (nháp chưa áp dụng). Công khai, chỉ trả `{ total }`.
 * Tham số sai → 422 (client giữ nhãn trung tính); nguồn dữ liệu lỗi → 503.
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
    return Response.json(
      { total: r.total },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch {
    return Response.json({ total: null }, { status: 503 });
  }
}
