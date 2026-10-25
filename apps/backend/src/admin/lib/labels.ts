/** Nhãn tiếng Việt cho mã giá trị server trả về (mã lạ → hiện nguyên mã, không giấu). */
const lookup = (table: Record<string, string>, code: string): string => table[code] ?? code;

export const PRIORITY_LABELS: Record<string, string> = {
  urgent: "Khẩn",
  high: "Cao",
  normal: "Thường",
  low: "Thấp",
};
export const priorityLabel = (c: string) => lookup(PRIORITY_LABELS, c);

export const EXCEPTION_SOURCE_LABELS: Record<string, string> = {
  ops: "Vận hành",
  settlement: "Đối soát",
  cod: "COD chưa đối soát",
};
export const sourceLabel = (c: string) => lookup(EXCEPTION_SOURCE_LABELS, c);

export const EXCEPTION_STATE_LABELS: Record<string, string> = {
  open: "Đang mở",
  in_progress: "Đang xử lý",
};
export const exceptionStateLabel = (c: string) => lookup(EXCEPTION_STATE_LABELS, c);

export const DISCREPANCY_KIND_LABELS: Record<string, string> = {
  missing: "Thiếu trên chứng từ",
  amount_mismatch: "Lệch số tiền",
  unexpected: "Thừa trên chứng từ",
  overpaid: "Thu dư",
  late_after_cancel: "Tiền về sau khi hủy",
  cod_unsettled: "COD chưa đối soát đủ",
  late_payment: "Thanh toán muộn",
  overpayment: "Thanh toán dư",
};
export const kindLabel = (c: string) => lookup(DISCREPANCY_KIND_LABELS, c);

export const REFUND_STATE_LABELS: Record<string, string> = {
  requested: "Chờ duyệt",
  approved: "Đã duyệt, chờ thực hiện",
  rejected: "Đã từ chối",
  processing: "Đang hoàn",
  succeeded: "Đã hoàn",
  failed: "Hoàn lỗi (thử lại được)",
  unknown: "Chưa rõ kết quả (hỏi lại cổng)",
};
export const refundStateLabel = (c: string) => lookup(REFUND_STATE_LABELS, c);

export const RETURN_STATE_LABELS: Record<string, string> = {
  requested: "Chờ duyệt",
  approved: "Chờ khách gửi hàng",
  rejected: "Đã từ chối",
  received: "Đã nhận, chờ kiểm định",
  inspected: "Đã kiểm định",
  closed: "Hoàn tất",
};
export const returnStateLabel = (c: string) => lookup(RETURN_STATE_LABELS, c);

export const REFUND_REASON_LABELS: Record<string, string> = {
  cancellation: "Hủy đơn",
  overpayment: "Thanh toán dư",
  late_payment: "Thanh toán muộn",
  return: "Trả hàng",
  other: "Khác",
};
export const refundReasonLabel = (c: string) => lookup(REFUND_REASON_LABELS, c);

export const REFUND_METHOD_LABELS: Record<string, string> = {
  provider: "Qua cổng thanh toán",
  manual: "Ngoài hệ thống",
};
export const refundMethodLabel = (c: string) => lookup(REFUND_METHOD_LABELS, c);

/** Màu Badge của @medusajs/ui theo mức ưu tiên. */
export function priorityColor(priority: string): "red" | "orange" | "blue" | "grey" {
  if (priority === "urgent") return "red";
  if (priority === "high") return "orange";
  if (priority === "normal") return "blue";
  return "grey";
}
