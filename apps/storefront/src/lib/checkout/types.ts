/** Kiểu dữ liệu checkout phía storefront (an toàn cho client). Tiền: số nguyên VND. Thời gian: ISO 8601 UTC. */
import type { CheckoutPaymentMethod } from "@x-shop/domain/validation";

/** Một nguồn: `CHECKOUT_PAYMENT_METHODS` của schema chung (T-188). */
export type PaymentMethod = CheckoutPaymentMethod;

export interface AddressInput {
  provinceCode: string;
  wardCode: string;
  line: string;
}

export interface ContactInput {
  name: string;
  phone: string;
  /** Rỗng = không có. */
  email: string;
}

export interface QuoteLine {
  lineItemId: string;
  variantId: string | null;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  discount: number;
  total: number;
}

/** Báo giá do server tính (CHK04): tiền hàng, giảm giá, phí ship, tổng. Client không tự tính tiền. */
export interface QuoteView {
  id: string;
  cartVersion: number;
  expiresAt: string;
  paymentMethod: PaymentMethod;
  discountCode: string | null;
  lines: QuoteLine[];
  subtotal: number;
  /** Giảm giá cấp đơn (mã giảm giá). */
  discountTotal: number;
  shippingFee: number;
  /** Giảm phí vận chuyển (nếu có). */
  shippingDiscount: number;
  shippingTotal: number;
  total: number;
}

export type QuoteErrorCode =
  | "CART_EMPTY"
  | "VALIDATION"
  | "DISCOUNT_NOT_APPLICABLE"
  | "DISCOUNT_EXHAUSTED"
  | "ADDRESS_NOT_SERVED"
  | "INSUFFICIENT_STOCK"
  | "NOT_FOUND"
  | "UNAVAILABLE";

export type QuoteResult =
  { ok: true; quote: QuoteView } | { ok: false; code: QuoteErrorCode; message: string; field?: string };

export interface SubmitInput {
  /** Sinh 1 lần cho mỗi lần xác nhận; giữ nguyên khi retry do lỗi mạng. */
  idempotencyKey: string;
  quoteId: string;
  cartVersion: number;
  paymentMethod: PaymentMethod;
  contact: ContactInput;
  address: AddressInput;
  /** Mã đang áp dụng — chỉ để báo giá lại khi giỏ đổi (không gửi kèm submit). */
  discountCode: string | null;
}

export interface PlacedOrder {
  attemptId: string;
  /** Mã đơn hiển thị cho khách (XS-xxxxxx). */
  ref: string;
  state: string;
  total: number;
  paymentUrl: string | null;
}

export type ChangedCode =
  "CART_CHANGED" | "PRICE_CHANGED" | "SHIPPING_CHANGED" | "DISCOUNT_CHANGED" | "QUOTE_EXPIRED";

export interface StockShortage {
  lineItemId: string;
  variantId: string | null;
  requested: number;
  available: number;
}

export type SubmitResult =
  | ({ kind: "placed" } & PlacedOrder)
  | { kind: "pending"; attemptId: string }
  /** 409 giá/phí/ưu đãi/giỏ đổi: có báo giá mới để khách xác nhận lại (AT03). `quote` null = chưa lấy được. */
  | { kind: "changed"; code: ChangedCode; message: string; quote: QuoteView | null }
  | { kind: "stock"; message: string; lines: StockShortage[] }
  | { kind: "busy"; retryAfterMs: number }
  /** 503 LOCK_UNAVAILABLE: hạ tầng khóa tạm ngưng; không tạo đơn; thử lại CÙNG khóa sau `Retry-After`. */
  | { kind: "unavailable"; retryAfterSeconds: number | null }
  | {
      kind: "error";
      code: string;
      message: string;
      field?: string;
      /** true: lần đặt này đã chấm dứt — lần sau phải dùng khóa idempotency mới. */
      newKey: boolean;
    }
  | { kind: "network" };

export type PollResult =
  | ({ kind: "placed" } & PlacedOrder)
  | { kind: "pending" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "network" };
