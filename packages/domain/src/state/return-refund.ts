import { isNonEmpty } from "../presence.js";
import { canRetryRefund } from "./machine.js";

/**
 * Hoàn theo trả hàng (T-173, D-127): số tiền do kiểm định chốt (AT15) và chỉ mở lại theo `return_id` khi bản trước đã
 * `cancelled` — nên KHÔNG từ chối được (bản `rejected` vẫn chiếm `IDX_x_refund_return_unique`, yêu cầu trả kẹt). Hàm thuần
 * dùng chung cho server (`rejectRefund`) và Admin (bản sao trong `admin/lib/refund-actions.ts`, có test khoá).
 */
export function isReturnRefund(r: { reason: string; return_id: string | null | undefined }): boolean {
  return r.reason === "return" || isNonEmpty(r.return_id);
}

export const RETURN_REFUND_STEPS = ["approve", "execute", "cancel", "recreate"] as const;
export type ReturnRefundStep = (typeof RETURN_REFUND_STEPS)[number];

/**
 * Đường đi tiếp của một hoàn theo trả hàng thay cho "từ chối", theo cách hoàn và trạng thái hiện tại:
 *  - kết thúc (`succeeded`/`rejected`/`cancelled`) hoặc trạng thái lạ → [];
 *  - `manual` (gồm mọi đơn COD) không bao giờ tự vào `failed` → chỉ duyệt/thực hiện (kèm `evidence_ref`);
 *  - `provider` `requested`/`approved` → duyệt/thực hiện; đổi cách hoàn = `failed` → hủy → tạo lại theo `return_id`;
 *  - `failed` → thực hiện lại nếu còn lượt (`canRetryRefund`), luôn hủy được → tạo lại;
 *  - `processing`/`unknown` → chỉ thực hiện lại (hỏi cổng / chốt chứng từ) — chưa nhả được vì cổng có thể đã hoàn.
 */
export function returnRefundNextSteps(
  r: { method: string; state: string; attempts: number },
  maxAttempts: number,
): ReturnRefundStep[] {
  const manual = r.method === "manual";
  switch (r.state) {
    case "requested":
      return manual ? ["approve", "execute"] : ["approve", "execute", "cancel", "recreate"];
    case "approved":
      return manual ? ["execute"] : ["execute", "cancel", "recreate"];
    case "failed":
      return canRetryRefund({ state: "failed", attempts: r.attempts }, maxAttempts)
        ? ["execute", "cancel", "recreate"]
        : ["cancel", "recreate"];
    case "processing":
    case "unknown":
      return ["execute"];
    default:
      return [];
  }
}
