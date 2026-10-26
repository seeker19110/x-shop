import type { AnalyticsPayload } from "../../lib/analytics/schema";
import type { OrderDetails } from "../../lib/orders/types";

/**
 * Định nghĩa `purchase` theo chính sách báo cáo (đặc tả §13.1, AT29) — CHỈ từ trạng thái do server tính, không từ URL:
 * - VNPAY: thanh toán đã xác nhận (`paymentState === "paid"`, ledger ≥ tổng tiền);
 * - COD: đơn đã được xác nhận (`confirmed`/`completed`) — `order_placed` (lúc bấm đặt) đã là sự kiện vận hành riêng;
 * - đơn đã hủy, đang chờ, chưa rõ → không.
 * Payload chỉ có mã đơn hiển thị, tổng tiền (số nguyên VND) và phương thức — không PII, không dòng hàng (tên sản phẩm
 * không phải định danh). Trùng `order_id` bị `track()` bỏ (dedupe bền trên trình duyệt).
 */
export type PurchaseSource = Pick<
  OrderDetails,
  "ref" | "state" | "paymentMethod" | "paymentState" | "totals"
>;

export function purchaseEventOf(order: PurchaseSource): AnalyticsPayload | null {
  if (order.state === "cancelled") return null;
  const value = order.totals.total;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const paidOnline = order.paymentMethod === "vnpay" && order.paymentState === "paid";
  const codConfirmed =
    order.paymentMethod === "cod" &&
    (order.state === "confirmed" || order.state === "completed") &&
    (order.paymentState === "cod" || order.paymentState === "paid");
  if (!paidOnline && !codConfirmed) return null;
  return { event: "purchase", order_id: order.ref, value, payment_type: order.paymentMethod };
}
