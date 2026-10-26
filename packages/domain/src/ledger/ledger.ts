import { err, ok, type Result } from "../result.js";
import { assertNonNegativeVnd, sumVnd } from "../money/money.js";
import type { OrderState, RefundState } from "../state/machine.js";

/** Bút toán tiền đã xác minh từ provider (hoặc chứng từ COD). Refund là giao dịch mới, không ghi đè (§6.1). */
export type LedgerEntry =
  | { kind: "capture"; amount: number; providerTxnId: string }
  | { kind: "refund"; amount: number; refundId: string; state: RefundState };

const HELD_REFUND_STATES: readonly RefundState[] = [
  "requested",
  "approved",
  "processing",
  "unknown",
  "failed",
];

/** Trạng thái hoàn đã nhả tiền giữ và không bao giờ chi: không tính vào "đã giữ", không chiếm chỗ của giao dịch gốc. */
const RELEASED_REFUND_STATES: readonly RefundState[] = ["rejected", "cancelled"];

/** Refund còn chiếm tiền của khoản thu (đang giữ hoặc đã hoàn) — dùng khi chia số hoàn theo giao dịch gốc. */
export const refundOccupiesCapture = (state: RefundState): boolean => !RELEASED_REFUND_STATES.includes(state);

export interface LedgerTotals {
  captured: number;
  refundSucceeded: number;
  /** Tiền đang giữ cho yêu cầu hoàn chưa ngã ngũ (gồm failed chờ retry cùng refund). */
  refundHeld: number;
  /** captured − refundSucceeded */
  net: number;
}

export function ledgerTotals(entries: readonly LedgerEntry[]): LedgerTotals {
  const captured = sumVnd(entries.filter((e) => e.kind === "capture").map((e) => e.amount));
  const refunds = entries.filter((e): e is Extract<LedgerEntry, { kind: "refund" }> => e.kind === "refund");
  const refundSucceeded = sumVnd(refunds.filter((r) => r.state === "succeeded").map((r) => r.amount));
  const refundHeld = sumVnd(refunds.filter((r) => HELD_REFUND_STATES.includes(r.state)).map((r) => r.amount));
  return { captured, refundSucceeded, refundHeld, net: captured - refundSucceeded };
}

/**
 * S-108/AT16: Σ refund thành công + Σ refund đang giữ + yêu cầu mới ≤ Σ đã thu hợp lệ.
 * Gọi dưới khóa theo payment/đơn để hai yêu cầu đồng thời không cùng vượt.
 */
export function checkRefundAllowed(
  entries: readonly LedgerEntry[],
  amount: number,
): Result<number, "REFUND_EXCEEDS_CAPTURED" | "VALIDATION"> {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    return err("VALIDATION", "Số tiền hoàn phải > 0", "amount");
  const t = ledgerTotals(entries);
  const available = t.captured - t.refundSucceeded - t.refundHeld;
  if (amount > available) {
    return err("REFUND_EXCEEDS_CAPTURED", `Chỉ còn hoàn được ${Math.max(0, available)} đồng`, "amount");
  }
  return ok(available - amount);
}

/** S-302/AT13: số thu tại cửa = phần còn phải trả; đơn đã trả đủ online → 0. */
export function codAmount(orderTotal: number, entries: readonly LedgerEntry[]): number {
  assertNonNegativeVnd(orderTotal, "orderTotal");
  return Math.max(0, orderTotal - ledgerTotals(entries).net);
}

/** AT36: tiền thu dư so với tổng đơn (sau hoàn). */
export function overpaidAmount(orderTotal: number, entries: readonly LedgerEntry[]): number {
  return Math.max(0, ledgerTotals(entries).net - orderTotal);
}

export type CaptureDecision =
  /** Đủ tiền khi đơn đang chờ → xác nhận đơn MỘT lần; `overpaid` > 0 → caller mở thêm ngoại lệ hoàn phần dư. */
  | { action: "confirm_order"; overpaid: number }
  /** Ghi khoản thu, đơn chưa đủ tiền → giữ chờ (thu thiếu). */
  | { action: "record_only"; reason: "underpaid" }
  /** AT09: đơn đã hủy → ghi tiền + ngoại lệ hoàn, không giao. */
  | { action: "exception"; reason: "late_payment"; amount: number }
  /** AT36: khoản thu thật thứ hai khi đơn đã xác nhận → ghi + ngoại lệ hoàn phần dư; không xác nhận lần hai. */
  | { action: "exception"; reason: "overpayment"; amount: number };

/**
 * Quyết định sau khi MỘT khoản thu mới (đã khử trùng theo providerTxnId) được ghi vào ledger.
 * `entriesAfter` đã gồm khoản thu mới. Hàm thuần — caller giữ khóa đơn để S-006 (expiry ∥ IPN) có một kết quả.
 */
export function decideOnCapture(
  orderState: OrderState,
  orderTotal: number,
  entriesAfter: readonly LedgerEntry[],
  newCaptureAmount: number,
): CaptureDecision {
  if (orderState === "cancelled")
    return { action: "exception", reason: "late_payment", amount: newCaptureAmount };
  const net = ledgerTotals(entriesAfter).net;
  if (orderState === "confirmed" || orderState === "completed") {
    const over = Math.max(0, net - orderTotal);
    return { action: "exception", reason: "overpayment", amount: over > 0 ? over : newCaptureAmount };
  }
  if (net < orderTotal) return { action: "record_only", reason: "underpaid" };
  return { action: "confirm_order", overpaid: net - orderTotal };
}

export interface ReconcileResult {
  expectedNet: number;
  receivedNet: number;
  difference: number;
  state: "settled" | "partially_settled" | "disputed" | "unsettled";
}

/**
 * Đối soát một kỳ (COD/cổng): expected = gross − fee theo hệ thống; received = số thực nhận theo chứng từ.
 * Chưa nhận gì → unsettled; nhận thiếu → partially_settled; nhận đủ → settled; nhận thừa → disputed.
 */
export function reconcile(expectedGross: number, fee: number, received: number | null): ReconcileResult {
  assertNonNegativeVnd(expectedGross, "expectedGross");
  assertNonNegativeVnd(fee, "fee");
  const expectedNet = expectedGross - fee;
  if (received === null) return { expectedNet, receivedNet: 0, difference: -expectedNet, state: "unsettled" };
  assertNonNegativeVnd(received, "received");
  const difference = received - expectedNet;
  const state = difference === 0 ? "settled" : difference < 0 ? "partially_settled" : "disputed";
  return { expectedNet, receivedNet: received, difference, state };
}
