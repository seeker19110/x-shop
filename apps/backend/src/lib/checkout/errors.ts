/**
 * Lỗi checkout có mã ổn định (đặc tả §9.1): HTTP trả `application/problem+json` (RFC 9457) với `code` cố định, thông
 * báo tiếng Việt và `field` khi là lỗi dữ liệu. Lỗi đi qua workflow bị engine tuần tự hoá (serializeError giữ thuộc
 * tính riêng) — nhận dạng lại bằng `readCheckoutError`.
 */
export const CHECKOUT_ERROR_STATUS = {
  VALIDATION: 422,
  CART_EMPTY: 422,
  LIMIT: 422,
  DISCOUNT_NOT_APPLICABLE: 422,
  ADDRESS_NOT_SERVED: 422,
  NOT_FOUND: 404,
  CART_CHANGED: 409,
  PRICE_CHANGED: 409,
  SHIPPING_CHANGED: 409,
  DISCOUNT_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  INSUFFICIENT_STOCK: 409,
  DISCOUNT_EXHAUSTED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BUSY_RETRY: 409,
  ATTEMPT_ABORTED: 409,
  NOT_CANCELLABLE: 409,
  PAYMENT_PENDING: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SHIPPING_UNAVAILABLE: 503,
} as const;

export type CheckoutErrorCode = keyof typeof CHECKOUT_ERROR_STATUS;

/** Lỗi tạm thời: cùng Idempotency-Key được thử lại (attempt mở lại), không phải đổi key. */
export const RETRYABLE_CODES: readonly CheckoutErrorCode[] = ["BUSY_RETRY", "SHIPPING_UNAVAILABLE"];

const DEFAULT_MESSAGES: Record<CheckoutErrorCode, string> = {
  VALIDATION: "Dữ liệu chưa hợp lệ",
  CART_EMPTY: "Giỏ hàng đang trống",
  LIMIT: "Vượt giới hạn cho phép",
  DISCOUNT_NOT_APPLICABLE: "Mã giảm giá không áp dụng được cho đơn này",
  ADDRESS_NOT_SERVED: "Đơn vị vận chuyển chưa giao tới địa chỉ này, vui lòng chọn địa chỉ khác",
  NOT_FOUND: "Không tìm thấy giỏ hàng",
  CART_CHANGED: "Giỏ hàng đã thay đổi, vui lòng xem lại trước khi đặt",
  PRICE_CHANGED: "Giá sản phẩm đã thay đổi, vui lòng xác nhận tổng tiền mới",
  SHIPPING_CHANGED: "Phí vận chuyển đã thay đổi, vui lòng xác nhận tổng tiền mới",
  DISCOUNT_CHANGED: "Ưu đãi đã thay đổi, vui lòng xác nhận tổng tiền mới",
  QUOTE_EXPIRED: "Báo giá đã hết hạn, vui lòng xem lại tổng tiền",
  INSUFFICIENT_STOCK: "Một số sản phẩm không còn đủ hàng",
  DISCOUNT_EXHAUSTED: "Mã giảm giá đã hết lượt sử dụng",
  IDEMPOTENCY_CONFLICT: "Yêu cầu trùng khóa nhưng khác nội dung với lần gửi trước",
  BUSY_RETRY: "Hệ thống đang bận xử lý đơn khác, vui lòng thử lại sau giây lát",
  ATTEMPT_ABORTED: "Lần đặt hàng trước bị gián đoạn, vui lòng đặt lại",
  NOT_CANCELLABLE: "Đơn hàng không còn hủy được ở trạng thái hiện tại",
  PAYMENT_PENDING: "Đang xác nhận thanh toán với cổng, vui lòng thử lại sau ít phút",
  RATE_LIMITED: "Bạn thao tác quá nhanh, vui lòng thử lại sau ít giây",
  INTERNAL: "Không thể xử lý yêu cầu lúc này",
  SHIPPING_UNAVAILABLE: "Chưa lấy được phí vận chuyển, vui lòng thử lại sau giây lát",
};

/** Hành động gợi ý cho client (đặc tả §9.1 "kèm hành động cần làm"). */
const ACTIONS: Partial<Record<CheckoutErrorCode, string>> = {
  CART_CHANGED: "requote",
  PRICE_CHANGED: "confirm_new_quote",
  SHIPPING_CHANGED: "confirm_new_quote",
  DISCOUNT_CHANGED: "confirm_new_quote",
  QUOTE_EXPIRED: "requote",
  INSUFFICIENT_STOCK: "update_cart",
  DISCOUNT_EXHAUSTED: "remove_discount",
  BUSY_RETRY: "retry_same_key",
  ATTEMPT_ABORTED: "resubmit_new_key",
  RATE_LIMITED: "retry_later",
  ADDRESS_NOT_SERVED: "change_address",
  SHIPPING_UNAVAILABLE: "retry_same_key",
  PAYMENT_PENDING: "retry_later",
  NOT_CANCELLABLE: "contact_support",
};

export type CheckoutErrorDetail = Record<string, unknown>;

const MARK = "x_checkout_error";

export class CheckoutError extends Error {
  override readonly name = "CheckoutError";
  readonly [MARK] = true;
  readonly code: CheckoutErrorCode;
  readonly status: number;
  readonly field: string | undefined;
  readonly detail: CheckoutErrorDetail | undefined;

  constructor(
    code: CheckoutErrorCode,
    message?: string,
    opts: { field?: string; detail?: CheckoutErrorDetail } = {},
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.code = code;
    this.status = CHECKOUT_ERROR_STATUS[code];
    this.field = opts.field;
    this.detail = opts.detail;
  }
}

/** Dạng đã tuần tự hoá (qua workflow engine) hoặc instance — đọc lại thành CheckoutError; khác → null. */
export function readCheckoutError(value: unknown): CheckoutError | null {
  if (value instanceof CheckoutError) return value;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v[MARK] !== true || typeof v.code !== "string" || !(v.code in CHECKOUT_ERROR_STATUS)) return null;
  return new CheckoutError(
    v.code as CheckoutErrorCode,
    typeof v.message === "string" ? v.message : undefined,
    {
      ...(typeof v.field === "string" && { field: v.field }),
      ...(typeof v.detail === "object" && v.detail !== null && { detail: v.detail as CheckoutErrorDetail }),
    },
  );
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: CheckoutErrorCode;
  detail: string;
  field?: string;
  action?: string;
  [extra: string]: unknown;
}

/** Thân `application/problem+json`. Chi tiết nghiệp vụ (vd quote mới, dòng thiếu hàng) nằm ở khóa riêng. */
export function toProblem(error: CheckoutError): ProblemBody {
  const body: ProblemBody = {
    type: `https://x-shop.vn/problems/${error.code.toLowerCase().replace(/_/g, "-")}`,
    title: DEFAULT_MESSAGES[error.code],
    status: error.status,
    code: error.code,
    detail: error.message,
  };
  if (error.field !== undefined) body.field = error.field;
  const action = ACTIONS[error.code];
  if (action !== undefined) body.action = action;
  if (error.detail) {
    for (const [k, v] of Object.entries(error.detail)) {
      if (!(k in body)) body[k] = v;
    }
  }
  return body;
}

interface ProblemResponse {
  status(code: number): ProblemResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

export function sendProblem(res: ProblemResponse, error: CheckoutError): void {
  res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (error.code === "BUSY_RETRY") res.setHeader("Retry-After", "1");
  if (error.code === "SHIPPING_UNAVAILABLE") res.setHeader("Retry-After", "5");
  if (error.code === "RATE_LIMITED") {
    const after = error.detail?.retry_after_seconds;
    res.setHeader("Retry-After", String(typeof after === "number" ? after : 10));
  }
  res.status(error.status).json(toProblem(error));
}
