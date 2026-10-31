import { isNonEmpty, refundOccupiesCapture, sumVnd } from "@x-shop/domain";
import type { RefundMethod } from "../../modules/returns/constants";
import type { RefundRow } from "../../modules/returns/service";
import { ReturnsError } from "./errors";

/** Khoản đã thu hợp lệ của đơn. COD đã giao: tiền hãng thu hộ là khoản thu (chứng từ COD đối soát riêng ở T-028). */
export interface CaptureInfo {
  provider: string;
  provider_txn_id: string;
  amount: number;
  /**
   * Khoản thu gắn đúng một attempt (`payment_attempt.provider_txn_no = provider_txn_id`) — điều kiện để hoàn qua cổng
   * (`providerRequestOf` tìm giao dịch gốc theo đúng phép so này, cùng phép join của đối soát VNPAY). Khoản thu đến khi
   * attempt đã mang mã khác (xung đột — T-168/T-169) không gắn → chỉ hoàn tay.
   */
  linked: boolean;
}

/**
 * Nguồn tiền để định tuyến một yêu cầu hoàn (T-169): các khoản thu + đơn có đang mở `payment_unknown`
 * `attempt_txn_conflict` (khoản thu không gắn được attempt — D-125) hay không + cổng hoàn có bật không.
 */
export interface RefundSources {
  captures: CaptureInfo[];
  txnConflict: boolean;
  gatewayEnabled: boolean;
}

/** Phần của một khoản thu chưa bị refund cổng chiếm (mỗi refund cổng gắn MỘT giao dịch gốc). */
function roomOf(c: CaptureInfo, refunds: readonly RefundRow[]): number {
  const used = sumVnd(
    refunds
      .filter(
        (r) =>
          r.method === "provider" && r.capture_ref === c.provider_txn_id && refundOccupiesCapture(r.state),
      )
      .map((r) => r.amount),
  );
  return Math.max(0, c.amount - used);
}

/** Khoản thu VNPAY gắn attempt (hoàn qua cổng được) còn đủ chỗ cho một lần hoàn qua cổng. */
function pickProviderCapture(
  captures: readonly CaptureInfo[],
  refunds: readonly RefundRow[],
  amount: number,
): CaptureInfo | null {
  for (const c of captures.filter((x) => x.provider === "vnpay" && x.linked)) {
    if (roomOf(c, refunds) >= amount) return c;
  }
  return null;
}

/** Vì sao `auto` chọn hoàn tay cho đơn có khoản thu VNPAY — ghi vào `note` của refund cho kế toán (T-169). */
export type AutoManualReason =
  "provider_disabled" | "attempt_txn_conflict" | "capture_unlinked" | "exceeds_single_capture";

const AUTO_MANUAL_TEXT: Record<AutoManualReason, string> = {
  provider_disabled: "cổng hoàn tiền đang tắt ở môi trường này",
  attempt_txn_conflict:
    "đơn có khoản thu xung đột mã giao dịch (payment_unknown) — đối chiếu trên cổng merchant",
  capture_unlinked: "khoản thu còn lại không gắn giao dịch gốc nên không hoàn qua cổng được",
  exceeds_single_capture: "số tiền vượt phần còn lại của một giao dịch gốc",
};

/**
 * Ghi chú của refund `auto` → `manual`: giữ ghi chú người tạo, nối MỌI lý do (mã máy đọc được trong ngoặc) — vd. ở
 * sandbox/live đơn có xung đột mã ghi cả `attempt_txn_conflict` lẫn `provider_disabled` (RUNBOOK §7).
 */
export function autoManualNote(note: string | null, reasons: readonly AutoManualReason[]): string {
  const tag = `[Hoàn tay do hệ thống chọn: ${reasons.map((r) => AUTO_MANUAL_TEXT[r]).join("; ")} (${reasons.join(", ")})]`;
  const own = note?.trim() ?? "";
  return isNonEmpty(own) ? `${own} ${tag}` : tag;
}

export type RefundRoute =
  { method: "provider"; capture: CaptureInfo } | { method: "manual"; reasons: AutoManualReason[] };

/**
 * Định tuyến phương thức hoàn (T-169). `provider` chỉ khi cổng hoàn BẬT và có khoản thu VNPAY gắn attempt đủ chỗ; chọn
 * `provider` tường minh mà không được → lỗi ngay khi tạo (không tạo yêu cầu chắc chắn kẹt). `auto` → `manual` có lý do khi
 * cổng tắt, đơn đang có xung đột mã giao dịch, hoặc không khoản thu nào hoàn qua cổng được. Đơn không có khoản thu VNPAY
 * (COD) → `manual` như trước, không ghi lý do. Hàm thuần — gọi dưới khóa đơn với danh sách refund đọc trong transaction.
 */
export function routeRefund(
  sources: RefundSources,
  refunds: readonly RefundRow[],
  amount: number,
  requested: RefundMethod | "auto",
): RefundRoute {
  if (requested === "manual") return { method: "manual", reasons: [] };
  const { gatewayEnabled } = sources;
  const vnpay = sources.captures.filter((c) => c.provider === "vnpay");
  const pick = pickProviderCapture(sources.captures, refunds, amount);
  if (requested === "provider") {
    if (vnpay.length === 0) {
      throw new ReturnsError(
        "REFUND_METHOD_UNAVAILABLE",
        "Đơn không có giao dịch cổng để hoàn — dùng manual",
      );
    }
    if (!gatewayEnabled) {
      throw new ReturnsError(
        "REFUND_PROVIDER_DISABLED",
        "Hoàn qua cổng chưa được bật ở môi trường này — dùng hoàn ngoài hệ thống (manual) có chứng từ",
      );
    }
    if (pick) return { method: "provider", capture: pick };
    const linkedRoom = sumVnd(vnpay.filter((c) => c.linked).map((c) => roomOf(c, refunds)));
    if (linkedRoom >= amount) {
      throw new ReturnsError(
        "REFUND_SPLIT_REQUIRED",
        "Số tiền vượt một giao dịch gốc — chia thành nhiều lần hoàn",
      );
    }
    throw new ReturnsError(
      "REFUND_METHOD_UNAVAILABLE",
      "Số tiền này không hoàn qua cổng được (khoản thu còn lại không gắn giao dịch gốc) — dùng manual",
      { provider_refundable: linkedRoom },
    );
  }
  if (vnpay.length === 0) return { method: "manual", reasons: [] };
  // Xung đột mã ghi TRƯỚC (cần đối chiếu dù cổng có bật); cổng tắt ghi kèm — không lý do nào che lý do kia.
  const blocked: AutoManualReason[] = [];
  if (sources.txnConflict) blocked.push("attempt_txn_conflict");
  if (!gatewayEnabled) blocked.push("provider_disabled");
  if (blocked.length > 0) return { method: "manual", reasons: blocked };
  if (pick) return { method: "provider", capture: pick };
  return {
    method: "manual",
    reasons: [vnpay.some((c) => !c.linked) ? "capture_unlinked" : "exceeds_single_capture"],
  };
}
