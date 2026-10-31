import { StoreApiError, storeApi } from "../cart/medusa";
import { cartEnabled } from "../cart/service";
import { readOrderAccess, writeOrderAccess } from "./cookie";
import { mapOrderResponse, ORDER_REF_RE } from "./map";
import type { LookupState, OrderResult } from "./types";
import { isNonEmpty } from "../presence";

/**
 * Gọi `/store/x/orders/*` từ SERVER. Token phiên đơn đọc từ cookie HttpOnly và gửi qua header `x-order-access` — không
 * bao giờ qua URL hay tới trình duyệt. Hàm không ném lỗi nghiệp vụ.
 */

async function call(
  path: string,
  req: Parameters<typeof storeApi>[1] = {},
): Promise<{ status: number; body: unknown }> {
  try {
    // storeApi tự chuyển tiếp IP khách (lib/security/client-ip.ts) cho giới hạn theo IP ở backend (AT20).
    const r = await storeApi<unknown>(path, req);
    return { status: r.status, body: r.data };
  } catch (e) {
    if (e instanceof StoreApiError) return { status: e.status, body: e.body };
    return { status: 0, body: null };
  }
}

async function withAccess(
  ref: string,
  run: (token: string) => Promise<{ status: number; body: unknown }>,
): Promise<{ result: OrderResult; raw: unknown }> {
  if (!cartEnabled() || !ORDER_REF_RE.test(ref)) return { result: { kind: "not_found" }, raw: null };
  const token = await readOrderAccess(ref);
  if (!isNonEmpty(token)) return { result: { kind: "not_found" }, raw: null };
  const r = await run(token);
  return { result: mapOrderResponse(r.status, r.body), raw: r.body };
}

export async function fetchOrder(ref: string): Promise<OrderResult> {
  const { result } = await withAccess(ref, (token) =>
    call(`/store/x/orders/${encodeURIComponent(ref)}`, { headers: { "x-order-access": token } }),
  );
  return result;
}

/** "Kiểm tra lại": server hỏi cổng về CÙNG giao dịch — không tạo thanh toán mới (S-104). */
export async function recheckOrder(ref: string): Promise<OrderResult> {
  const { result } = await withAccess(ref, (token) =>
    call(`/store/x/orders/${encodeURIComponent(ref)}/recheck`, {
      method: "POST",
      body: {},
      headers: { "x-order-access": token },
    }),
  );
  return result;
}

export async function cancelOrder(ref: string): Promise<OrderResult & { refundRequested?: boolean }> {
  const { result: r, raw } = await withAccess(ref, (token) =>
    call(`/store/x/orders/${encodeURIComponent(ref)}/cancel`, {
      method: "POST",
      body: {},
      headers: { "x-order-access": token },
    }),
  );
  if (r.kind !== "ok") return r;
  const cancel = (raw as { cancel?: { refund_requested?: unknown } } | null)?.cancel;
  return { ...r, refundRequested: cancel?.refund_requested === true };
}

const LOOKUP_FALLBACK =
  "Nếu thông tin đúng, chúng tôi đã gửi liên kết xem đơn tới số điện thoại/email đã dùng khi đặt hàng.";

/** Tra cứu bằng mã đơn + SĐT: luôn cùng một thông điệp, không lộ đơn có tồn tại (POST01). */
export async function lookupOrder(ref: string, phone: string): Promise<LookupState> {
  if (!cartEnabled()) return { status: "error", message: "Tra cứu đơn tạm thời chưa khả dụng." };
  const r = await call("/store/x/orders/lookup", { method: "POST", body: { display_ref: ref, phone } });
  const b = (r.body ?? {}) as { message?: unknown; detail?: unknown; field?: unknown };
  if (r.status === 202) {
    return { status: "sent", message: typeof b.message === "string" ? b.message : LOOKUP_FALLBACK };
  }
  if (r.status === 422) {
    const field = b.field === "phone" ? "phone" : "ref";
    return {
      status: "invalid",
      field,
      message: typeof b.detail === "string" ? b.detail : "Thông tin chưa hợp lệ",
    };
  }
  if (r.status === 429) {
    return { status: "rate_limited", message: "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau." };
  }
  return { status: "error", message: "Không gửi được yêu cầu lúc này. Vui lòng thử lại sau ít phút." };
}

/** Đổi liên kết tra cứu (một lần) thành cookie phiên đơn. Trả mã đơn khi thành công. */
export async function redeemLink(token: string): Promise<string | null> {
  if (!cartEnabled() || typeof token !== "string" || token.length === 0 || token.length > 512) return null;
  const r = await call("/store/x/orders/session", { method: "POST", body: { token } });
  if (r.status !== 200) return null;
  const b = (r.body ?? {}) as {
    display_ref?: unknown;
    order_access?: unknown;
    order_access_expires_at?: unknown;
  };
  const ref = typeof b.display_ref === "string" ? b.display_ref : "";
  return (await writeOrderAccess(ref, b.order_access, b.order_access_expires_at)) ? ref : null;
}
