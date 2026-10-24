import { loadCartCount } from "../../../../lib/cart/service";

/** Số lượng trong giỏ của phiên (đọc cookie HttpOnly) cho badge header. Riêng tư: không bao giờ cache (S-505). */
export async function GET(): Promise<Response> {
  const count = await loadCartCount();
  return Response.json({ count }, { headers: { "Cache-Control": "private, no-store" } });
}
