import { EMPTY_FILTER, normalizeQuery } from "@x-shop/domain";
import { CATALOG_API_CACHE_CONTROL } from "../../../../lib/cache-policy";
import { rateLimitedResponse } from "../../../../lib/catalog/rate-limited";
import { proxyNet, search } from "../../../../lib/catalog/client";

/** Tối đa gợi ý trả về và tối thiểu ký tự để gợi ý (CAT01). */
const MAX_SUGGESTIONS = 8;
const MIN_SUGGEST_CHARS = 2;

/**
 * Gợi ý truy vấn khi gõ: tên sản phẩm khớp (có/không dấu) — công khai, chỉ trả `{ suggestions: string[] }`.
 * Truy vấn được chuẩn hóa NFC và cắt 100 ký tự (cùng quy tắc với tìm kiếm); quá ngắn → danh sách rỗng, không gọi
 * nguồn dữ liệu. Nguồn lỗi → 503 (client chỉ đóng danh sách, không hiện lỗi).
 */
export async function GET(request: Request): Promise<Response> {
  const q = normalizeQuery(new URL(request.url).searchParams.get("q"));
  if (q === null || [...q].length < MIN_SUGGEST_CHARS) {
    return Response.json({ suggestions: [] }, { headers: { "Cache-Control": CATALOG_API_CACHE_CONTROL } });
  }
  try {
    const r = await search(
      { ...EMPTY_FILTER, q },
      { pageSize: MAX_SUGGESTIONS, net: proxyNet(request.signal) },
    );
    const titles = [...new Set(r.items.map((i) => i.title))].slice(0, MAX_SUGGESTIONS);
    return Response.json(
      { suggestions: titles },
      { headers: { "Cache-Control": CATALOG_API_CACHE_CONTROL } },
    );
  } catch (e) {
    return rateLimitedResponse(e, { suggestions: [] }) ?? Response.json({ suggestions: [] }, { status: 503 });
  }
}
