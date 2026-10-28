import { isNonEmpty } from "./presence";
/**
 * Nút thao tác của một yêu cầu hoàn tiền trên trang Admin — thuần, server vẫn là nơi quyết (máy trạng thái, quyền,
 * tự duyệt, lượt thử). UI chỉ ẩn/khoá nút chắc chắn bị từ chối để người dùng không bấm vô ích.
 */

/**
 * Số lần gửi tối đa của một yêu cầu hoàn (= `RETURNS_CONFIG.refundMaxAttempts` của server — bundle Admin không nạp được
 * module server; test khoá hai số bằng nhau).
 */
export const REFUND_MAX_ATTEMPTS = 3;

export interface RefundLike {
  id: string;
  state: string;
  attempts: number;
  reason: string;
  return_id: string | null;
  requested_by: string | null;
}

export interface RefundActions {
  /** Duyệt/từ chối (chỉ `requested`). Hoàn theo trả hàng không có nút từ chối (server trả 409 — T-173). */
  approve: boolean;
  reject: boolean;
  /** `requested` theo trả hàng: thay nút từ chối bằng hướng dẫn (duyệt → thực hiện; đổi cách hoàn → hủy khi failed). */
  rejectBlocked: boolean;
  /** Người đang đăng nhập là người tạo → không tự duyệt được (S-403). */
  selfCreated: boolean;
  /** Thực hiện / thử lại / hỏi lại cổng. */
  execute: boolean;
  executeLabel: string | null;
  /** `failed` đã hết lượt thử (hoặc server vừa báo REFUND_RETRY_EXHAUSTED) — chỉ còn hủy rồi tạo mới. */
  exhausted: boolean;
  /** Hủy yêu cầu `failed` (lý do bắt buộc) để nhả số đang giữ. */
  cancel: boolean;
  /** Tạo lại hoàn theo trả hàng (`reason=return` + `return_id`, D-030) sau khi bản trước đã hủy. */
  recreate: boolean;
}

export interface RefundActionContext {
  myId?: string | null;
  /** Mọi yêu cầu hoàn đã biết của cùng đơn (trang theo đơn) — để không đề nghị tạo lại khi đã có bản hiệu lực. */
  siblings?: readonly RefundLike[];
  /** Id server đã trả REFUND_RETRY_EXHAUSTED trong phiên này. */
  exhaustedIds?: ReadonlySet<string>;
  maxAttempts?: number;
}

/** Hết lượt thử: `failed` và attempts ≥ max (attempts hỏng → coi như hết, không mời thử lại mù). */
export function isRetryExhausted(
  r: Pick<RefundLike, "state" | "attempts">,
  maxAttempts = REFUND_MAX_ATTEMPTS,
) {
  if (r.state !== "failed") return false;
  return !Number.isSafeInteger(r.attempts) || r.attempts >= maxAttempts;
}

/** Hoàn gắn yêu cầu trả (khớp server `isReturnRefund`): không từ chối được — chỉ hủy khi `failed` rồi tạo lại. */
export const isReturnRefund = (r: Pick<RefundLike, "reason" | "return_id">) =>
  r.reason === "return" || isNonEmpty(r.return_id);

export function refundActions(r: RefundLike, ctx: RefundActionContext = {}): RefundActions {
  const requested = r.state === "requested";
  const returnRefund = isReturnRefund(r);
  const exhausted =
    r.state === "failed" &&
    (isRetryExhausted(r, ctx.maxAttempts ?? REFUND_MAX_ATTEMPTS) || (ctx.exhaustedIds?.has(r.id) ?? false));
  const execute = r.state === "approved" || r.state === "unknown" || (r.state === "failed" && !exhausted);
  const recreate =
    r.state === "cancelled" &&
    r.reason === "return" &&
    isNonEmpty(r.return_id) &&
    !(ctx.siblings ?? []).some(
      (s) => s.id !== r.id && s.return_id === r.return_id && s.state !== "cancelled",
    );
  return {
    approve: requested,
    reject: requested && !returnRefund,
    rejectBlocked: requested && returnRefund,
    selfCreated: requested && isNonEmpty(ctx.myId) && r.requested_by === ctx.myId,
    execute,
    executeLabel: !execute ? null : r.state === "approved" ? "Thực hiện" : "Thử lại / hỏi lại cổng",
    exhausted,
    cancel: r.state === "failed",
    recreate,
  };
}

export type RefundMethodChoice = "auto" | "provider" | "manual";

/** Thân POST /admin/x/refunds để tạo lại hoàn theo trả hàng — số tiền server tính theo kiểm định (không gửi amount). */
export function recreateRefundBody(
  r: Pick<RefundLike, "return_id"> & { order_id: string },
  method: RefundMethodChoice,
  note: string,
): { order_id: string; reason: "return"; return_id: string; method: RefundMethodChoice; note?: string } {
  if (!isNonEmpty(r.return_id)) throw new Error("Yêu cầu hoàn không gắn yêu cầu trả");
  const n = note.trim().slice(0, 500);
  return { order_id: r.order_id, reason: "return", return_id: r.return_id, method, ...(n && { note: n }) };
}
