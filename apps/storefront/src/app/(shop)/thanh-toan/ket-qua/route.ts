import { NextResponse } from "next/server";
import { requestAttempt } from "../../../../lib/checkout/service";
import { readLastOrderRef, readOrderAccess } from "../../../../lib/orders/cookie";
import { ORDER_REF_RE } from "../../../../lib/orders/map";
import { recheckOrder } from "../../../../lib/orders/service";

/**
 * Trang trở về từ VNPAY (`VNPAY_RETURN_URL`, có thể kèm `?attempt=…`). KHÔNG đổi trạng thái theo tham số URL (AT08,
 * AT24): `vnp_ResponseCode`… không được đọc. Chỉ xác định đơn của phiên này (attempt → giỏ của phiên, hoặc cookie
 * `xs_order_last`), nhờ server kiểm tra lại CÙNG giao dịch (querydr) rồi chuyển tới `/don-hang/:ref` — trang đơn hiển thị
 * "Đang xác nhận thanh toán" cho tới khi server xác nhận. Không có phiên đơn (mở trên thiết bị/trình duyệt khác) →
 * trang tra cứu với thông báo "đang xác nhận".
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function go(request: Request, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  for (const [k, v] of Object.entries(NO_STORE)) res.headers.set(k, v);
  return res;
}

/** Mã đơn trong `vnp_OrderInfo` ("Thanh toan don XS-…") — chỉ để điền sẵn ô tra cứu, không dùng để cấp quyền. */
function refFromOrderInfo(info: string | null): string | null {
  const m = /\b(XS-[A-Z0-9]{4,12})\b/.exec(info ?? "");
  return m && ORDER_REF_RE.test(m[1] as string) ? (m[1] as string) : null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  let ref: string | null = null;
  const attempt = url.searchParams.get("attempt");
  if (attempt) {
    // Attempt của giỏ trong phiên này (cookie giỏ) — server đặt luôn cookie phiên đơn nếu đơn đã tạo.
    const r = await requestAttempt(attempt);
    if (r.kind === "placed") ref = r.ref;
  }
  ref ??= await readLastOrderRef();
  if (ref && (await readOrderAccess(ref))) {
    await recheckOrder(ref); // kết quả hiển thị ở trang đơn; lỗi/429 không chặn chuyển trang
    return go(request, `/don-hang/${encodeURIComponent(ref)}`);
  }
  const hint = refFromOrderInfo(url.searchParams.get("vnp_OrderInfo"));
  return go(request, `/tra-cuu-don?tu=thanh-toan${hint ? `&ma=${encodeURIComponent(hint)}` : ""}`);
}
