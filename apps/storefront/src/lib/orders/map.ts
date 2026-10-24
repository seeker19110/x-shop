import type { OrderDetails, OrderResult, OrderState, PaymentState, ShipmentState } from "./types";

/**
 * Ánh xạ phản hồi của `/store/x/orders/*` sang kiểu storefront. Thuần, không I/O. Dữ liệu sai hình dạng → null/lỗi có
 * kiểm soát; KHÔNG BAO GIỜ nâng trạng thái thanh toán lên "paid" khi dữ liệu lạ (AT24).
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, f = ""): string => (typeof v === "string" ? v : f);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

const UNAVAILABLE = "Không tải được thông tin đơn lúc này. Vui lòng thử lại sau ít phút.";

/** Mã đơn hiển thị (XS-xxxxxx) — kiểm chặt trước khi đưa vào URL/cookie/lời gọi backend. */
export const ORDER_REF_RE = /^XS-[A-Z0-9]{4,12}$/;

const ORDER_STATES: readonly OrderState[] = ["placed", "awaiting_payment", "confirmed", "cancelled", "completed"];
const PAYMENT_STATES: readonly PaymentState[] = [
  "cod",
  "pending",
  "unknown",
  "paid",
  "refund_pending",
  "expired",
  "void",
];
const SHIPMENT_STATES: readonly ShipmentState[] = ["unfulfilled", "picking", "packed", "shipped", "delivered"];

export function mapOrder(raw: unknown): OrderDetails | null {
  if (!isObj(raw)) return null;
  const ref = str(raw.display_ref);
  const state = raw.state as OrderState;
  const method = raw.payment_method;
  if (!ORDER_REF_RE.test(ref) || !ORDER_STATES.includes(state) || (method !== "cod" && method !== "vnpay")) {
    return null;
  }
  const t = isObj(raw.totals) ? raw.totals : {};
  const totals = {
    subtotal: int(t.subtotal),
    discountTotal: int(t.discount_total),
    shippingTotal: int(t.shipping_total),
    total: int(t.total),
    paid: int(t.paid),
  };
  if (Object.values(totals).some((v) => v === null)) return null;
  const lines: OrderDetails["lines"] = [];
  for (const l of Array.isArray(raw.lines) ? raw.lines : []) {
    if (!isObj(l)) return null;
    const quantity = int(l.quantity);
    const unitPrice = int(l.unit_price);
    const total = int(l.total);
    if (quantity === null || unitPrice === null || total === null) return null;
    lines.push({
      title: str(l.title, "Sản phẩm"),
      variantTitle: strOrNull(l.variant_title),
      quantity,
      unitPrice,
      total,
      thumbnail: strOrNull(l.thumbnail),
    });
  }
  const timeline = (Array.isArray(raw.timeline) ? raw.timeline : [])
    .filter(isObj)
    .map((e) => ({ at: str(e.at), kind: str(e.kind), label: str(e.label) }))
    .filter((e) => e.at !== "" && !Number.isNaN(Date.parse(e.at)) && e.label !== "");
  const a = isObj(raw.address) ? raw.address : {};
  const c = isObj(raw.contact) ? raw.contact : {};
  const actions = isObj(raw.actions) ? raw.actions : {};
  const paymentState = PAYMENT_STATES.includes(raw.payment_state as PaymentState)
    ? (raw.payment_state as PaymentState)
    : "unknown";
  const shipmentState = SHIPMENT_STATES.includes(raw.shipment_state as ShipmentState)
    ? (raw.shipment_state as ShipmentState)
    : "unfulfilled";
  return {
    ref,
    state,
    paymentMethod: method,
    paymentState,
    shipmentState,
    createdAt: str(raw.created_at),
    holdExpiresAt: strOrNull(raw.hold_expires_at),
    codConfirmBy: strOrNull(raw.cod_confirm_by),
    cancelReason: strOrNull(raw.cancel_reason),
    timeline,
    lines,
    totals: totals as OrderDetails["totals"],
    address: { provinceName: str(a.province_name), wardName: str(a.ward_name), line: str(a.line) },
    contact: { name: str(c.name), phone: str(c.phone) },
    canCancel: actions.can_cancel === true,
    canRecheck: actions.can_recheck === true,
  };
}

/** (status, body) của GET/POST đơn → kết quả có kiểm soát. */
export function mapOrderResponse(status: number, body: unknown, retryAfter: string | null = null): OrderResult {
  if (status === 0) return { kind: "network" };
  if (status === 200) {
    const order = mapOrder(body);
    return order ? { kind: "ok", order } : { kind: "error", code: "UNAVAILABLE", message: UNAVAILABLE };
  }
  if (status === 404) return { kind: "not_found" };
  const b = isObj(body) ? body : {};
  if (status === 429) {
    const s = Number(retryAfter ?? b.retry_after_seconds);
    return { kind: "rate_limited", retryAfterS: Number.isFinite(s) && s > 0 ? Math.ceil(s) : 10 };
  }
  return {
    kind: "error",
    code: str(b.code, "UNAVAILABLE"),
    message: status >= 500 || !str(b.detail) ? UNAVAILABLE : str(b.detail),
  };
}
