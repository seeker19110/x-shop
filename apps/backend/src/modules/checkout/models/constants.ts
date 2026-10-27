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
  /** Thông báo khách (email/SMS) gửi hỏng quá số lần tối đa (T-029, AT18) — đơn không bị ảnh hưởng. */
  "notification_failed",
  /** Khách hủy đơn đã trả tiền (POST02, T-021) — chờ hoàn tiền + hủy native ở luồng hoàn tiền (T-027). */
  "refund_request",
  /** Read model catalog dựng lệch: SKU có giá niêm yết mà không ra giá bán (D-040) — bảng cũ được giữ. */
  "catalog_index_mismatch",
  /** Bù trừ `set-product-fashion` lỗi (D-095): sản phẩm có thể lệch thuộc tính/bảng size/số đo — chỉ id + mã lỗi. */
  "catalog_compensation_failed",
  /**
   * Circuit breaker chi phí của job nền mở (T-097, OPS-COST-004): một adapter/bộ xử lý outbox lỗi liên tiếp hoặc hết ngân
   * sách lượt gọi trong ngày → dừng gọi dịch vụ ngoài tới hết thời gian nguội; sự kiện hoãn vẫn nằm trong outbox.
   */
  "job_circuit_open",
] as const;
export type OpsExceptionKind = (typeof OPS_EXCEPTION_KINDS)[number];

/**
 * Hàng rào T-158 (D-107): kind dùng `openOpsExceptionIfNoneActive` → dạng `active_scope` DUY NHẤT của nó (tập khoá trong
 * `detail`; `[]` = một ngoại lệ đang mở cho cả kind). Helper khoá theo kind + giá trị phạm vi — hai dạng khác nhau cho
 * cùng kind giao nhau về điều kiện nhưng khác khoá (tạo trùng được), nên helper ném lỗi khi kind chưa khai ở đây hoặc
 * người gọi truyền dạng khác.
 */
export const OPS_EXCEPTION_ACTIVE_SCOPES: { readonly [K in OpsExceptionKind]?: readonly string[] } = {
  catalog_index_mismatch: [],
  // T-142: chỉ dòng outbox `catalog.revalidate` chết đi qua helper (một ngoại lệ đang mở mỗi loại sự kiện); loại khác vẫn
  // mở mỗi sự kiện một ngoại lệ qua `openOpsException`.
  outbox_dead: ["type"],
  catalog_compensation_failed: ["product_id"],
  /** Mỗi breaker (vd. `notify`) một ngoại lệ đang mở — mở lại khi đã xử lý xong mà breaker lại mở. */
  job_circuit_open: ["breaker"],
};

/**
 * Circuit breaker job nền (T-097): `closed` = gọi bình thường · `open` = không gọi tới `open_until` · `half_open` = hết
 * nguội, đúng MỘT lượt thử (probe) đang bay tới `probe_until`; thành công → closed, lỗi → open lại.
 */
export const JOB_BREAKER_STATES = ["closed", "open", "half_open"] as const;
export type JobBreakerState = (typeof JOB_BREAKER_STATES)[number];
/** Lý do mở: lỗi liên tiếp của adapter, hoặc hết ngân sách lượt gọi trong cửa sổ (ngày). */
export const JOB_BREAKER_TRIP_REASONS = ["consecutive_failures", "budget_exhausted"] as const;
export type JobBreakerTripReason = (typeof JOB_BREAKER_TRIP_REASONS)[number];

export const OPS_EXCEPTION_STATES = ["open", "in_progress", "resolved"] as const;
export const OPS_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const COUPON_USAGE_STATES = ["held", "used", "released"] as const;
export type CouponUsageState = (typeof COUPON_USAGE_STATES)[number];
/** Trạng thái coupon_usage tính vào hạn mức (AT33). */
export const COUNTED_COUPON_STATES = ["held", "used"] as const satisfies readonly CouponUsageState[];
