import { err, ok, type Result } from "../result.js";

/** Máy trạng thái hữu hạn: danh sách chuyển hợp lệ là dữ liệu, kiểm bằng test (đặc tả §6.1). */
export interface Machine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  canTransition(from: S, to: S): boolean;
  transition(from: S, to: S): Result<S, "INVALID_TRANSITION">;
  isTerminal(s: S): boolean;
}

export function defineMachine<S extends string>(
  name: string,
  transitions: Record<S, readonly S[]>,
): Machine<S> {
  const states = Object.keys(transitions) as S[];
  for (const [from, tos] of Object.entries(transitions) as [S, readonly S[]][]) {
    for (const to of tos) {
      if (!(to in transitions)) throw new Error(`${name}: ${from} → ${to} trỏ tới trạng thái không khai báo`);
    }
  }
  const terminal = states.filter((s) => transitions[s].length === 0);
  return {
    name,
    states,
    terminal,
    canTransition: (from, to) => transitions[from]?.includes(to) ?? false,
    transition(from, to) {
      return transitions[from]?.includes(to)
        ? ok(to)
        : err("INVALID_TRANSITION", `${name}: không cho chuyển ${from} → ${to}`);
    },
    isTerminal: (s) => transitions[s]?.length === 0,
  };
}

export const ORDER_STATES = [
  "preparing",
  "awaiting_payment",
  "placed",
  "confirmed",
  "cancelled",
  "completed",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Đơn thương mại. `preparing` = đang tạo + giữ hàng (chưa được gọi cổng/xuất kho); online → `awaiting_payment`;
 * COD → `placed`. `cancelled` và `completed` là kết thúc — đơn đã giao không "hủy" để xóa lịch sử (POST02).
 */
export const orderMachine = defineMachine<OrderState>("order", {
  preparing: ["awaiting_payment", "placed", "cancelled"],
  awaiting_payment: ["confirmed", "cancelled"],
  placed: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled"],
  cancelled: [],
  completed: [],
});

export const PAYMENT_STATES = ["created", "pending", "authorized", "captured", "failed", "unknown"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** Lần thanh toán. `unknown` (timeout) chỉ thoát bằng kết quả đối chiếu với provider (AT11). */
export const paymentMachine = defineMachine<PaymentState>("payment", {
  created: ["pending", "failed", "unknown"],
  pending: ["authorized", "captured", "failed", "unknown"],
  unknown: ["pending", "authorized", "captured", "failed"],
  authorized: ["captured", "failed"],
  captured: [],
  failed: [],
});

export const SHIPMENT_STATES = [
  "unfulfilled",
  "picking",
  "packed",
  "shipped",
  "delivered",
  "failed",
  "returning",
  "returned",
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export const shipmentMachine = defineMachine<ShipmentState>("shipment", {
  unfulfilled: ["picking"],
  picking: ["packed", "unfulfilled"],
  packed: ["shipped", "picking"],
  shipped: ["delivered", "failed", "returning"],
  failed: ["shipped", "returning"],
  delivered: ["returning"],
  returning: ["returned"],
  returned: [],
});

export const RETURN_STATES = [
  "requested",
  "approved",
  "rejected",
  "received",
  "inspected",
  "closed",
] as const;
export type ReturnState = (typeof RETURN_STATES)[number];

export const returnMachine = defineMachine<ReturnState>("return", {
  requested: ["approved", "rejected"],
  approved: ["received", "closed"],
  rejected: ["closed"],
  received: ["inspected"],
  inspected: ["closed"],
  closed: [],
});

export const REFUND_STATES = [
  "requested",
  "approved",
  "rejected",
  "processing",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

/**
 * Hoàn tiền: retry dùng cùng bản ghi (failed → processing), không tạo refund mới (§6.5). Retry có giới hạn
 * (`canRetryRefund`); hết lượt hoặc đổi cách hoàn → `failed → cancelled` (T-044): nhả số đang giữ để mở yêu cầu MỚI
 * (duyệt lại từ đầu). Chỉ `failed` hủy được — `unknown`/`processing` có thể đã trừ tiền ở cổng, phải đối chiếu trước.
 */
export const refundMachine = defineMachine<RefundState>("refund", {
  requested: ["approved", "rejected"],
  approved: ["processing"],
  processing: ["succeeded", "failed", "unknown"],
  unknown: ["succeeded", "failed"],
  // failed → succeeded: chỉ bằng ĐỐI CHIẾU với cổng (hỏi cùng mã trước khi hủy thấy cổng đã hoàn) — không hủy nhầm.
  failed: ["processing", "succeeded", "cancelled"],
  rejected: [],
  succeeded: [],
  cancelled: [],
});

/**
 * Thử lại hoàn tiền có giới hạn (T-044): `failed → processing` chỉ khi số lần đã gửi (`attempts`, tăng mỗi lần vào
 * `processing`) còn dưới `maxAttempts`. Hết lượt → hủy yêu cầu (`failed → cancelled`) rồi tạo yêu cầu mới.
 */
export function canRetryRefund(r: { state: RefundState; attempts: number }, maxAttempts: number): boolean {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts phải là số nguyên ≥ 1 (nhận ${maxAttempts})`);
  }
  return r.state === "failed" && Number.isSafeInteger(r.attempts) && r.attempts < maxAttempts;
}

export const SETTLEMENT_STATES = ["unsettled", "partially_settled", "settled", "disputed"] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

export const settlementMachine = defineMachine<SettlementState>("settlement", {
  unsettled: ["partially_settled", "settled", "disputed"],
  partially_settled: ["settled", "disputed"],
  disputed: ["settled", "partially_settled"],
  settled: [],
});

/**
 * Áp trạng thái do provider báo (callback có thể lặp/sai thứ tự). Đích đã là trạng thái hiện tại → no-op;
 * chuyển không hợp lệ → bỏ qua có lý do (KHÔNG lùi captured → pending — D-003); hợp lệ → đổi.
 */
export function applyProviderState<S extends string>(
  machine: Machine<S>,
  current: S,
  incoming: S,
): { state: S; changed: boolean; ignored: null | "duplicate" | "out_of_order" } {
  if (current === incoming) return { state: current, changed: false, ignored: "duplicate" };
  if (machine.canTransition(current, incoming)) return { state: incoming, changed: true, ignored: null };
  return { state: current, changed: false, ignored: "out_of_order" };
}
