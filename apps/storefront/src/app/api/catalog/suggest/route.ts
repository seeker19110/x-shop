import { EMPTY_FILTER, normalizeQuery } from "@x-shop/domain";
import { search } from "../../../../lib/catalog/client";

/** Tối đa gợi ý trả về và tối thiểu ký tự để gợi ý (CAT01). */
const MAX_SUGGESTIONS = 8;
const MIN_SUGGEST_CHARS = 2;

const CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/**
 * Gợi ý truy vấn khi gõ: tên sản phẩm khớp (có/không dấu) — công khai, chỉ trả `{ suggestions: string[] }`.
 * Truy vấn được chuẩn hóa NFC và cắt 100 ký tự (cùng quy tắc với tìm kiếm); quá ngắn → danh sách rỗng, không gọi
 * nguồn dữ liệu. Nguồn lỗi → 503 (client chỉ đóng danh sách, không hiện lỗi).
 */
export async function GET(request: Request): Promise<Response> {
  const q = normalizeQuery(new URL(request.url).searchParams.get("q"));
  if (q === null || [...q].length < MIN_SUGGEST_CHARS) {
    return Response.json({ suggestions: [] }, { headers: { "Cache-Control": CACHE } });
  }
  try {
    const r = await search({ ...EMPTY_FILTER, q }, { pageSize: MAX_SUGGESTIONS });
    const titles = [...new Set(r.items.map((i) => i.title))].slice(0, MAX_SUGGESTIONS);
    return Response.json({ suggestions: titles }, { headers: { "Cache-Control": CACHE } });
  } catch {
    return Response.json({ suggestions: [] }, { status: 503 });
  }
}
