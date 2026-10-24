/** Kiểu dữ liệu đơn sau mua phía storefront (an toàn cho client). Tiền: số nguyên VND. Thời gian: ISO 8601 UTC. */

export type OrderState = "placed" | "awaiting_payment" | "confirmed" | "cancelled" | "completed";

/**
 * Trạng thái thanh toán do SERVER tính (ledger/cổng) — storefront không bao giờ tự suy ra "đã thanh toán" từ URL hay
 * dữ liệu cũ (AT08, AT24). Giá trị lạ từ backend → `unknown`.
 */
export type PaymentState = "cod" | "pending" | "unknown" | "paid" | "refund_pending" | "expired" | "void";

export type ShipmentState = "unfulfilled" | "picking" | "packed" | "shipped" | "delivered";

export interface OrderTimelineEntry {
  at: string;
  kind: string;
  label: string;
}

export interface OrderLine {
  title: string;
  variantTitle: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  thumbnail: string | null;
}

export interface OrderDetails {
  ref: string;
  state: OrderState;
  paymentMethod: "cod" | "vnpay";
  paymentState: PaymentState;
  shipmentState: ShipmentState;
  createdAt: string;
  /** Hạn giữ hàng của đơn online — lấy từ server (CHK06). */
  holdExpiresAt: string | null;
  codConfirmBy: string | null;
  cancelReason: string | null;
  timeline: OrderTimelineEntry[];
  lines: OrderLine[];
  totals: { subtotal: number; discountTotal: number; shippingTotal: number; total: number; paid: number };
  address: { provinceName: string; wardName: string; line: string };
  /** SĐT đã che một phần ở server. */
  contact: { name: string; phone: string };
  canCancel: boolean;
  canRecheck: boolean;
}

/** Kết quả gọi backend cho trang đơn — không ném lỗi nghiệp vụ. */
export type OrderResult =
  | { kind: "ok"; order: OrderDetails }
  /** Không có quyền xem / không tồn tại / phiên hết hạn — không phân biệt (AT20). */
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterS: number }
  | { kind: "error"; code: string; message: string }
  | { kind: "network" };

export type LookupState =
  | { status: "idle" }
  | { status: "sent"; message: string }
  | { status: "invalid"; field: "ref" | "phone"; message: string }
  | { status: "rate_limited"; message: string }
  | { status: "error"; message: string };
