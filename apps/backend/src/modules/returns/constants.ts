/**
 * Giá trị liệt kê + cấu hình của module `returns` (T-027: đổi trả theo dòng, kiểm định, hoàn tiền). Một nguồn cho
 * migration (CHECK), service và route. Trạng thái đổi trả/hoàn tiền lấy nguyên từ máy trạng thái của `@x-shop/domain`
 * (đặc tả §6.1 là nguồn chuẩn).
 */
import { REFUND_STATES, RETURN_STATES } from "@x-shop/domain";

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
  /** Chờ khóa `order:<id>` trước khi trả 409 BUSY_RETRY. */
  lockWaitMs: 15_000,
} as const;
