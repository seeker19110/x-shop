/**
 * Giá trị liệt kê + cấu hình của module `returns` (T-027: đổi trả theo dòng, kiểm định, hoàn tiền). Một nguồn cho
 * migration (CHECK), service và route. Trạng thái đổi trả/hoàn tiền lấy nguyên từ máy trạng thái của `@x-shop/domain`
 * (đặc tả §6.1 là nguồn chuẩn).
 */
import { REFUND_STATES, RETURN_STATES, secondsToMs } from "@x-shop/domain";

export { REFUND_STATES, RETURN_STATES };

/** `return` = trả hàng hoàn tiền · `exchange` = đổi size qua đơn thay thế liên kết (đặc tả §6.5, S-310). */
export const RETURN_KINDS = ["return", "exchange"] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

/** Lý do yêu cầu đổi/trả (POST03 "có lý do"). */
export const RETURN_REASONS = [
  "wrong_size",
  "defective",
  "not_as_described",
  "changed_mind",
  "other",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Kênh tạo yêu cầu: khách tự tạo qua trang đơn hoặc CSKH tạo hộ (quyền `return.request`). */
export const RETURN_CHANNELS = ["customer", "staff"] as const;

/**
 * Lý do hoàn tiền. `return` = theo kết quả kiểm định hàng trả; `cancellation` = hủy đơn đã thu tiền (không chờ hàng trả —
 * đặc tả §6.5); `overpayment`/`late_payment` = ngoại lệ AT36/AT09; `other` = trường hợp khác có ghi chú.
 */
export const REFUND_REASONS = ["return", "cancellation", "overpayment", "late_payment", "other"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** `provider` = hoàn qua cổng (VNPAY refund API) · `manual` = hoàn ngoài hệ thống (chuyển khoản/COD) có chứng từ. */
export const REFUND_METHODS = ["provider", "manual"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/**
 * Tham số đổi trả/hoàn tiền — hằng có tên, đổi một chỗ (D-002). Thời hạn đổi trả là chính sách kinh doanh phải cấu hình
 * (đặc tả §6.5: không mặc định 7/14/30 ngày) → `returnWindowDays = null` = không áp hạn cho tới khi chủ shop cấu hình.
 */
export const RETURNS_CONFIG = {
  /** Hoàn tiền VƯỢT số này cần người thứ hai có `refund.approve` khác người tạo + xác thực lại MFA (S-403, S-402). */
  refundApprovalThresholdVnd: 1_000_000,
  /** Số ngày kể từ lúc giao thành công còn nhận yêu cầu đổi/trả; null = chưa cấu hình (không chặn). */
  returnWindowDays: null as number | null,
  /** Tối đa số dòng trong một yêu cầu đổi/trả. */
  maxLinesPerReturn: 50,
  /**
   * Số lần GỬI tối đa của một yêu cầu hoàn (lần đầu + thử lại, đếm ở `x_refund.attempts`) — T-044. Hết lượt mà vẫn
   * `failed` → 409 REFUND_RETRY_EXHAUSTED: hủy yêu cầu (nhả số đang giữ) rồi tạo yêu cầu mới (thường là `manual`).
   */
  refundMaxAttempts: 3,
  /** Chờ khóa `order:<id>` trước khi trả 409 BUSY_RETRY. */
  lockWaitMs: secondsToMs(15),
} as const;

/**
 * Khóa advisory theo đơn (T-052, D-032): `pg_advisory_xact_lock(hashtext(ORDER_LOCK_KEY_PREFIX || order_id))`. MỘT nguồn
 * cho `ReturnsModuleService.lockOrder` và trigger `x_refund_require_order_lock` (Migration20261026010000 — chép nguyên
 * chuỗi vào SQL vì migration đã áp không được đổi). Đổi tiền tố ở đây PHẢI kèm migration MỚI thay function trong DB;
 * test `refund-lock-guard` so khớp hai bên.
 */
export const ORDER_LOCK_KEY_PREFIX = "x-returns:order:";
export const orderLockKey = (orderId: string): string => `${ORDER_LOCK_KEY_PREFIX}${orderId}`;

/**
 * SQLSTATE trigger trả khi ghi `x_refund` làm tăng tiền chiếm chỗ (chèn mới; đổi từ rejected/cancelled về trạng thái còn
 * hiệu lực; tăng amount; đổi order_id) mà phiên hiện tại KHÔNG giữ khóa advisory của đơn — lỗi lập trình (quên
 * `lockOrder`), không phải lỗi nghiệp vụ.
 */
export const REFUND_LOCK_REQUIRED_SQLSTATE = "XR001";
