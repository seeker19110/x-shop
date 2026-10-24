/**
 * Giá trị liệt kê của module `checkout` — một nguồn cho model DSL, migration (CHECK) và mã nghiệp vụ.
 * Trạng thái đơn/thanh toán lấy nguyên từ `@x-shop/domain` (máy trạng thái là nguồn chuẩn, đặc tả §6.1).
 */
import { ORDER_STATES, PAYMENT_STATES } from "@x-shop/domain";

export const PAYMENT_METHODS = ["cod", "vnpay"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ATTEMPT_STATES = ["preparing", "ready", "failed", "compensated"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
/** Attempt "đang hoạt động" chiếm phiên bản giỏ (DATA02); failed/compensated nhả chỗ để checkout lại. */
export const ACTIVE_ATTEMPT_STATES = ["preparing", "ready"] as const satisfies readonly AttemptState[];

export { ORDER_STATES, PAYMENT_STATES };
/** Payment attempt còn hiệu lực — mỗi đơn tối đa một (đặc tả §6.2 "một payment attempt đang hoạt động"). */
export const ACTIVE_PAYMENT_STATES = ["created", "pending", "unknown"] as const;

export const LEDGER_KINDS = ["capture", "refund"] as const;
export const OUTBOX_STATES = ["pending", "sent", "failed", "dead"] as const;
export const OPS_EXCEPTION_KINDS = [
  "late_payment",
  "overpayment",
  "payment_unknown",
  "refund_unknown",
  "webhook_rejected",
  "checkout_stuck",
  /** Đơn COD quá hạn xác nhận (D-004) — nhân viên đơn gọi khách, không tự hủy. */
  "cod_confirm_overdue",
  /** Sự kiện outbox gửi hỏng quá số lần tối đa. */
  "outbox_dead",
] as const;
export const OPS_EXCEPTION_STATES = ["open", "in_progress", "resolved"] as const;
export const OPS_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const COUPON_USAGE_STATES = ["held", "used", "released"] as const;
export type CouponUsageState = (typeof COUPON_USAGE_STATES)[number];
/** Trạng thái coupon_usage tính vào hạn mức (AT33). */
export const COUNTED_COUPON_STATES = ["held", "used"] as const satisfies readonly CouponUsageState[];
