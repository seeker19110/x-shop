import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../lib/audit/record";
import { rejectWithoutRecentMfa } from "../../../../lib/admin-security/guard";
import { RETURNS_CONFIG } from "../../../../modules/returns/constants";
import { handleReturnsRouteError, ReturnsError } from "../../../../workflows/returns/errors";
import { actorOf, idempotencyKeyOf, parseBody, RefundCreateBody } from "../../../../workflows/returns/http";
import { createRefund, presentRefund, refundSummary } from "../../../../workflows/returns/refunds";

/**
 * POST /admin/x/refunds — tạo yêu cầu hoàn tiền (quyền `refund.request`; kho không có → 403, AT21). Header
 * `Idempotency-Key` bắt buộc (gửi lại → 200 bản cũ, khác nội dung → 409). Σ hoàn ≤ Σ đã thu kể cả các yêu cầu đang
 * giữ (422 REFUND_EXCEEDS_CAPTURED). Vượt ngưỡng (hoặc hoàn toàn bộ khi hủy đơn) → đòi xác thực lại MFA ≤ 5 phút và
 * người thứ hai duyệt (S-402, S-403). Hoàn theo trả hàng được tạo tự động khi kiểm định; chỉ khi bản đó đã bị hủy
 * (`failed → cancelled`, T-044) mới mở lại ở đây bằng `reason=return` + `return_id` (số tiền theo kiểm định).
 *
 * GET /admin/x/refunds?order_id=… — đã thu / đã hoàn / đang giữ / còn hoàn được + danh sách yêu cầu của đơn.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.request");
    const key = idempotencyKeyOf(req);
    const body = parseBody(RefundCreateBody, req.body);
    const large = body.amount === undefined || body.amount > RETURNS_CONFIG.refundApprovalThresholdVnd;
    if (large && rejectWithoutRecentMfa(req, res)) return;
    const { refund, replayed } = await createRefund(
      req.scope,
      {
        order_id: body.order_id,
        reason: body.reason,
        return_id: body.return_id ?? null,
        amount: body.amount ?? null,
        method: body.method ?? "auto",
        note: body.note ?? null,
        idempotency_key: key,
      },
      actor,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(replayed ? 200 : 201).json({ refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};

export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    actorOf(req, "refund.request");
    const orderId = typeof req.query.order_id === "string" ? req.query.order_id.trim() : "";
    if (!orderId || orderId.length > 128) {
      throw new ReturnsError("VALIDATION", "Cần order_id", { field: "order_id" });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await refundSummary(req.scope, orderId));
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
