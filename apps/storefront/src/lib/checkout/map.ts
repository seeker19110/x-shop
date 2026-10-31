import type {
  ChangedCode,
  PlacedOrder,
  PollResult,
  QuoteErrorCode,
  QuoteLine,
  QuoteResult,
  QuoteView,
  StockShortage,
  SubmitResult,
} from "./types";
import { isNonEmpty } from "../presence";
import { secondsToMs } from "../units";

/**
 * Ánh xạ phản hồi THẬT của `/store/x/checkout/*` (xem `__fixtures__/` — lấy từ backend chạy thật) sang kiểu storefront.
 * Thuần, không I/O. Dữ liệu sai hình dạng không làm ném lỗi mà trở thành lỗi/`null` có kiểm soát.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, f = ""): string => (typeof v === "string" ? v : f);

/** Tiền/số lượng: số nguyên không âm an toàn, nếu không → null (không che dữ liệu hỏng bằng 0). */
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Tên trường backend → tên trường của form. */
const FIELD_MAP: Record<string, string> = {
  "contact.name": "name",
  "contact.phone": "phone",
  "contact.email": "email",
  "address.province_code": "province",
  "address.ward_code": "ward",
  "address.line": "line",
  discount_code: "discount",
  payment_method: "payment",
};

export function formFieldOf(backendField: unknown): string | undefined {
  return typeof backendField === "string" ? FIELD_MAP[backendField] : undefined;
}

export function mapQuote(raw: unknown): QuoteView | null {
  if (!isObj(raw)) return null;
  const method = raw.payment_method;
  if (method !== "cod" && method !== "vnpay") return null;
  const subtotal = int(raw.subtotal);
  const discountTotal = int(raw.discount_total);
  const shippingFee = int(raw.shipping_fee);
  const shippingDiscount = int(raw.shipping_discount);
  const shippingTotal = int(raw.shipping_total);
  const total = int(raw.total);
  const cartVersion = int(raw.cart_version);
  if (
    subtotal === null ||
    discountTotal === null ||
    shippingFee === null ||
    shippingDiscount === null ||
    shippingTotal === null ||
    total === null ||
    cartVersion === null ||
    !str(raw.id)
  ) {
    return null;
  }
  const lines: QuoteLine[] = [];
  for (const l of Array.isArray(raw.lines) ? raw.lines : []) {
    if (!isObj(l)) return null;
    const unitPrice = int(l.unit_price);
    const quantity = int(l.quantity);
    const lineSubtotal = int(l.subtotal);
    const discount = int(l.discount);
    const lineTotal = int(l.total);
    if (
      unitPrice === null ||
      quantity === null ||
      lineSubtotal === null ||
      discount === null ||
      lineTotal === null
    ) {
      return null;
    }
    lines.push({
      lineItemId: str(l.line_item_id),
      variantId: typeof l.variant_id === "string" ? l.variant_id : null,
      unitPrice,
      quantity,
      subtotal: lineSubtotal,
      discount,
      total: lineTotal,
    });
  }
  return {
    id: str(raw.id),
    cartVersion,
    expiresAt: str(raw.expires_at),
    paymentMethod: method,
    discountCode: typeof raw.discount_code === "string" ? raw.discount_code : null,
    lines,
    subtotal,
    discountTotal,
    shippingFee,
    shippingDiscount,
    shippingTotal,
    total,
  };
}

const UNAVAILABLE_MSG = "Không kết nối được máy chủ. Vui lòng thử lại sau ít phút.";

export function mapQuoteResponse(status: number, body: unknown): QuoteResult {
  if (status === 200 && isObj(body)) {
    const quote = mapQuote(body.quote);
    if (quote) return { ok: true, quote };
    return { ok: false, code: "UNAVAILABLE", message: UNAVAILABLE_MSG };
  }
  if (status === 0 || status >= 500 || !isObj(body)) {
    return { ok: false, code: "UNAVAILABLE", message: UNAVAILABLE_MSG };
  }
  const code = str(body.code);
  const message = str(body.detail, "Không tính được tổng tiền. Vui lòng kiểm tra lại thông tin.");
  const known: QuoteErrorCode[] = [
    "CART_EMPTY",
    "VALIDATION",
    "DISCOUNT_NOT_APPLICABLE",
    "DISCOUNT_EXHAUSTED",
    "ADDRESS_NOT_SERVED",
    "INSUFFICIENT_STOCK",
    "NOT_FOUND",
  ];
  const mapped = (known as string[]).includes(code) ? (code as QuoteErrorCode) : "VALIDATION";
  const field = formFieldOf(body.field);
  return { ok: false, code: mapped, message, ...(isNonEmpty(field) ? { field } : {}) };
}

function mapPlaced(view: Json): PlacedOrder | null {
  const order = isObj(view.order) ? view.order : null;
  const total = order ? int(order.total) : null;
  if (!order || !str(order.display_ref) || total === null || !str(view.checkout_attempt_id)) return null;
  const url = typeof view.payment_url === "string" && view.payment_url !== "" ? view.payment_url : null;
  return {
    attemptId: str(view.checkout_attempt_id),
    ref: str(order.display_ref),
    state: str(order.state),
    total,
    paymentUrl: url,
  };
}

const CHANGED: readonly ChangedCode[] = [
  "CART_CHANGED",
  "PRICE_CHANGED",
  "SHIPPING_CHANGED",
  "DISCOUNT_CHANGED",
  "QUOTE_EXPIRED",
];

const BUSY_DEFAULT_MS = 1000;
const BUSY_MAX_MS = 5000;

export function mapSubmitResponse(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): SubmitResult {
  if (status === 503 && isObj(body) && str(body.code) === "LOCK_UNAVAILABLE") {
    // Header rỗng KHÔNG được thành 0 giây (Number("") === 0) — coi như thiếu.
    const s = isNonEmpty(retryAfterHeader) ? Number(retryAfterHeader) : NaN;
    return { kind: "unavailable", retryAfterSeconds: Number.isFinite(s) && s > 0 ? Math.ceil(s) : null };
  }
  if (status === 0 || status >= 500 || !isObj(body)) return { kind: "network" };
  if (status === 202) {
    return str(body.checkout_attempt_id)
      ? { kind: "pending", attemptId: str(body.checkout_attempt_id) }
      : { kind: "network" };
  }
  if (status >= 200 && status < 300) {
    const placed = mapPlaced(body);
    if (placed) return { kind: "placed", ...placed };
    return str(body.checkout_attempt_id)
      ? { kind: "pending", attemptId: str(body.checkout_attempt_id) }
      : { kind: "network" };
  }
  const code = str(body.code);
  const message = str(body.detail, "Không đặt được hàng. Vui lòng thử lại.");
  if ((CHANGED as readonly string[]).includes(code)) {
    return { kind: "changed", code: code as ChangedCode, message, quote: mapQuote(body.quote) };
  }
  if (code === "INSUFFICIENT_STOCK") {
    const lines: StockShortage[] = (Array.isArray(body.lines) ? body.lines : []).flatMap((l: unknown) =>
      isObj(l)
        ? [
            {
              lineItemId: str(l.line_item_id),
              variantId: typeof l.variant_id === "string" ? l.variant_id : null,
              requested: int(l.requested) ?? 0,
              available: int(l.available) ?? 0,
            },
          ]
        : [],
    );
    return { kind: "stock", message, lines };
  }
  if (code === "BUSY_RETRY") {
    const fromBody = int(body.retry_after_ms);
    // Header rỗng KHÔNG được thành 0 ms (Number("") === 0) — coi như thiếu.
    const header = isNonEmpty(retryAfterHeader) ? secondsToMs(Number(retryAfterHeader)) : NaN;
    const ms = fromBody ?? (Number.isFinite(header) ? header : BUSY_DEFAULT_MS);
    return { kind: "busy", retryAfterMs: Math.min(Math.max(ms, 0), BUSY_MAX_MS) };
  }
  const field = formFieldOf(body.field);
  // Các mã chấm dứt lần đặt này → lần sau cần khóa mới; lỗi dữ liệu (422) chưa tạo attempt.
  const newKey = status === 409 || status === 404;
  return { kind: "error", code: code || "ERROR", message, newKey, ...(isNonEmpty(field) ? { field } : {}) };
}

export function mapAttemptResponse(status: number, body: unknown): PollResult {
  if (status === 0 || status >= 500 || !isObj(body)) return { kind: "network" };
  if (status !== 200) {
    return {
      kind: "failed",
      code: str(body.code, "ERROR"),
      message: str(body.detail, "Không xác định được đơn hàng."),
    };
  }
  const state = str(body.state);
  if (state === "ready") {
    const placed = mapPlaced(body);
    if (placed) return { kind: "placed", ...placed };
    return { kind: "pending" };
  }
  if (state === "failed" || state === "compensated") {
    const err = isObj(body.error) ? body.error : {};
    const code = state === "compensated" ? "ATTEMPT_ABORTED" : str(err.code, "ERROR");
    const message =
      state === "compensated"
        ? "Lần đặt hàng trước bị gián đoạn. Vui lòng kiểm tra lại giỏ hàng và đặt lại."
        : str(err.message, "Không đặt được hàng. Vui lòng thử lại.");
    return { kind: "failed", code, message };
  }
  return { kind: "pending" };
}
