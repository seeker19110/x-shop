/**
 * Giá trị liệt kê + cấu hình của module `settlement` (T-028: đối soát COD/sao kê, chênh lệch, báo cáo — đặc tả §5.5,
 * AT14, SPEC-fulfillment S-304, SPEC-admin S-406). Một nguồn cho migration (CHECK), parser, service và route.
 *
 * ĐỊNH DẠNG FILE NHẬP LÀ GIẢ ĐỊNH NỘI BỘ (chưa xác minh định dạng xuất thật của GHN/VNPAY — xem D-014): CSV UTF-8, dấu
 * phẩy, dòng đầu là header đúng bốn cột `reference,amount,occurred_at,type` (không phân biệt hoa thường, thứ tự tùy ý,
 * không cột lạ). Đổi sang file thật của hãng = viết bộ chuyển đổi về đúng bốn cột này.
 *  - `reference`: GHN COD → `client_order_code` (hoặc mã vận đơn của hãng); VNPAY `payment` → `vnp_TxnRef`; VNPAY
 *    `refund` → `vnp_RequestId` của yêu cầu hoàn (`x_refund.provider_request_id`).
 *  - `amount`: số nguyên VND ≥ 0, chỉ chữ số (không dấu, không phân cách nghìn, không thập phân), ≤ trần cột integer.
 *  - `occurred_at`: RFC 3339 có giây và offset (`Z` hoặc `+07:00`) — thời điểm tiền chuyển/ghi có theo chứng từ.
 *  - `type`: GHN COD → `cod`; VNPAY → `payment` | `refund`.
 */

/** Nguồn chứng từ: `ghn_cod` = bảng kê tiền thu hộ hãng chuyển về; `vnpay` = sao kê giao dịch cổng. */
export const SETTLEMENT_SOURCES = ["ghn_cod", "vnpay"] as const;
export type SettlementSource = (typeof SETTLEMENT_SOURCES)[number];

export const SETTLEMENT_LINE_TYPES = ["cod", "payment", "refund"] as const;
export type SettlementLineType = (typeof SETTLEMENT_LINE_TYPES)[number];

/** Loại dòng hợp lệ theo nguồn. */
export const LINE_TYPES_BY_SOURCE: Record<SettlementSource, readonly SettlementLineType[]> = {
  ghn_cod: ["cod"],
  vnpay: ["payment", "refund"],
};

/** Đối tượng hệ thống mà một dòng chứng từ khớp vào (khóa cộng dồn số đã đối soát). */
export const SETTLEMENT_TARGET_KINDS = ["shipment", "capture", "refund"] as const;
export type SettlementTargetKind = (typeof SETTLEMENT_TARGET_KINDS)[number];

/**
 * Kết quả đối chiếu MỘT dòng chứng từ:
 *  - `matched`: đúng số còn phải nhận của đối tượng;
 *  - `amount_mismatch`: có đối tượng, số tiền lệch (thiếu hoặc dư) so với số còn phải nhận;
 *  - `unexpected`: hệ thống không có đối tượng tương ứng (thừa trên chứng từ);
 *  - `overpaid`: đối tượng đã đủ (hoặc không phải thu — vd. đơn đã trả online mà hãng vẫn thu COD, AT13) → thu dư;
 *  - `late_after_cancel`: tiền về cho đơn đã hủy (AT09) → ngoại lệ hoàn tiền.
 */
export const LINE_RESULTS = [
  "matched",
  "amount_mismatch",
  "unexpected",
  "overpaid",
  "late_after_cancel",
] as const;
export type LineResult = (typeof LINE_RESULTS)[number];

/** Loại chênh lệch: mọi kết quả khác `matched` + `missing` (hệ thống có, chứng từ trong kỳ không có). */
export const DISCREPANCY_KINDS = [
  "missing",
  "amount_mismatch",
  "unexpected",
  "overpaid",
  "late_after_cancel",
] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

export const DISCREPANCY_STATES = ["open", "resolved"] as const;
export type DiscrepancyState = (typeof DISCREPANCY_STATES)[number];

/** Lịch sử chênh lệch (chỉ ghi thêm). */
export const DISCREPANCY_EVENT_ACTIONS = ["opened", "auto_resolved", "resolved"] as const;
export type DiscrepancyEventAction = (typeof DISCREPANCY_EVENT_ACTIONS)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Tiền phải trả lại/thu hồi → ưu tiên cao; lệch/thiếu → bình thường. */
export const DISCREPANCY_PRIORITY: Record<DiscrepancyKind, Priority> = {
  late_after_cancel: "high",
  overpaid: "high",
  unexpected: "high",
  amount_mismatch: "normal",
  missing: "normal",
};

/** Chênh lệch tự đóng khi đối tượng đã nhận ĐÚNG đủ số phải nhận (thiếu/lệch được bù ở batch sau). */
export const AUTO_RESOLVABLE_KINDS: readonly DiscrepancyKind[] = ["missing", "amount_mismatch"];

/**
 * Vai trò mặc định chịu trách nhiệm theo loại mục trên dashboard ngoại lệ (§5.5 "có owner") khi chưa giao cho người cụ
 * thể (`owner` = user id). Tiền → kế toán; vận hành đơn → nhân viên đơn.
 */
export const EXCEPTION_OWNER_ROLE: Record<string, string> = {
  late_payment: "accountant",
  overpayment: "accountant",
  payment_unknown: "accountant",
  refund_unknown: "accountant",
  refund_request: "accountant",
  webhook_rejected: "owner",
  checkout_stuck: "order_staff",
  cod_confirm_overdue: "order_staff",
  outbox_dead: "order_staff",
  notification_failed: "order_staff",
  catalog_index_mismatch: "owner",
  catalog_compensation_failed: "owner",
  cod_unsettled: "accountant",
};
export const DEFAULT_SETTLEMENT_OWNER_ROLE = "accountant";

export const SETTLEMENT_CONFIG = {
  /** Trần file nhập (byte) — kiểm trước khi giải mã. */
  maxFileBytes: 1024 * 1024,
  /** Trần số dòng dữ liệu một batch. */
  maxRows: 5_000,
  /** Trần cột `integer` của Postgres (D-009) — vượt là lỗi dòng, không cắt. */
  maxAmountVnd: 2_147_483_647,
  /** Chấp nhận lệch đồng hồ: `occurred_at`/`period_end` không quá thời điểm hiện tại + chừng này. */
  futureSkewMs: 24 * 3600_000,
  /** Số lỗi dòng tối đa trả về (file lỗi hàng loạt không làm phình phản hồi). */
  maxReportedErrors: 100,
} as const;
