import { settlementMachine, type SettlementState } from "@x-shop/domain";
import type { LineResult, SettlementTargetKind } from "./constants";

/**
 * Đối chiếu thuần (không DB) một dòng chứng từ với đối tượng hệ thống. Caller giữ khóa theo nguồn để `alreadySettled`
 * (tổng các dòng đã nhập trước cho cùng đối tượng) không đổi giữa lúc đọc và lúc ghi.
 */
export interface SettlementTarget {
  kind: SettlementTargetKind;
  id: string;
  order_id: string | null;
  /** Số hệ thống chờ nhận cho đối tượng (COD phải thu / khoản thu cổng / khoản hoàn đã thành công). */
  expected: number;
  /** Đơn đã hủy → tiền về là "tiền đến sau hủy" (AT09), không tính là khớp. */
  order_cancelled: boolean;
}

export interface LineClassification {
  result: LineResult;
  /** Số còn phải nhận TRƯỚC dòng này; null = không có đối tượng. */
  expected: number | null;
  /** amount − expected (âm = thiếu, dương = dư); null khi khớp. */
  difference: number | null;
  /** Độ lớn tiền của chênh lệch (≥ 0) — số cần xử lý trên dashboard. */
  exposure: number;
}

export function classifyLine(
  amount: number,
  target: SettlementTarget | null,
  alreadySettled: number,
): LineClassification {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("amount phải là số nguyên VND ≥ 0");
  if (!target) return { result: "unexpected", expected: null, difference: amount, exposure: amount };
  const outstanding = target.expected - alreadySettled;
  if (target.order_cancelled) {
    return { result: "late_after_cancel", expected: outstanding, difference: amount, exposure: amount };
  }
  if (outstanding <= 0) {
    return { result: "overpaid", expected: Math.max(0, outstanding), difference: amount, exposure: amount };
  }
  if (amount === outstanding)
    return { result: "matched", expected: outstanding, difference: null, exposure: 0 };
  const difference = amount - outstanding;
  return { result: "amount_mismatch", expected: outstanding, difference, exposure: Math.abs(difference) };
}

/** Trạng thái đối soát suy ra từ tổng đã nhận so với số phải nhận (S-304). */
export function settlementStateFor(expected: number, received: number): SettlementState {
  if (received <= 0) return "unsettled";
  if (received < expected) return "partially_settled";
  if (received === expected) return "settled";
  return "disputed";
}

/**
 * Trạng thái mới theo máy trạng thái (`settled` là kết thúc — tiền về thêm sau khi đủ không kéo lùi, phần dư nằm ở
 * chênh lệch `overpaid`). null = giữ nguyên.
 */
export function nextSettlementState(
  current: SettlementState,
  expected: number,
  received: number,
): SettlementState | null {
  const next = settlementStateFor(expected, received);
  if (next === current) return null;
  return settlementMachine.canTransition(current, next) ? next : null;
}
