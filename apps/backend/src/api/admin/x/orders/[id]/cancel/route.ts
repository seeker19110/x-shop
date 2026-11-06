import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { cancelByStaff } from "../../../../../../lib/orders/cancel";
import { CHECKOUT_MODULE } from "../../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../../modules/checkout/service";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, CancelBody, idempotencyKeyOf, parseBody } from "../../../../../../workflows/returns/http";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/orders/:id/cancel — nhân viên quyền `order.cancel` hủy đơn (T-044; thay route native
 * `/admin/orders/:id/cancel` đã đóng). Body `{ reason }` bắt buộc, header `Idempotency-Key` bắt buộc. Đơn chưa thu →
 * hủy + nhả hàng; đơn đã thu → `order_finance=cancelled` + nhả hàng + mở yêu cầu hoàn toàn bộ (chờ người thứ hai duyệt —
 * D-012, S-403). 200 `cancel.outcome` cancelled|already_cancelled (gửi lại cùng khóa → kết quả cũ, header
 * `Idempotent-Replayed`) · 409 NOT_CANCELLABLE (đã có vận đơn / trạng thái kết thúc) · 409 PAYMENT_PENDING ·
 * 409 IDEMPOTENCY_CONFLICT · 404 NOT_FOUND · 422 thiếu lý do/khóa.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "order.cancel");
    const key = idempotencyKeyOf(req);
    const body = parseBody(CancelBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const orderId = params.data.id;
    const r = await cancelByStaff(
      req.scope,
      { order_id: orderId, actor_id: actor.id, reason: body.reason, idempotency_key: key },
      auditContextOf(req),
    );
    const [fin] = await req.scope
      .resolve<CheckoutModuleService>(CHECKOUT_MODULE)
      .listOrderFinances({ order_id: orderId });
    res.setHeader("Cache-Control", "no-store");
    if (r.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(200).json({
      order_id: orderId,
      state: fin?.state ?? null,
      cancel: { outcome: r.outcome, refund_requested: r.refund_requested, refund_id: r.refund_id },
    });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
