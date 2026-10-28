import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { cancelUnverified } from "../../../../../../lib/orders/cancel-unverified";
import { CHECKOUT_MODULE } from "../../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../../modules/checkout/service";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import {
  actorOf,
  CancelUnverifiedBody,
  idempotencyKeyOf,
  parseBody,
} from "../../../../../../workflows/returns/http";

/**
 * POST /admin/x/orders/:id/cancel-unverified — nhân viên quyền `payment.override` (chỉ owner; MFA + xác thực lại ≤ 5 phút, D-122) hủy đơn chờ thanh
 * toán có thanh toán CHƯA XÁC MINH (attempt `unknown` hoặc pending quá hạn giữ hàng) sau khi đối chiếu tay trên cổng
 * merchant VNPAY (T-165, D-118). Body `{ reason (10–500), merchant_ref }`, header `Idempotency-Key` bắt buộc. Hủy +
 * nhả hàng + đóng `payment_unknown` + audit `order.cancelled_unverified`; tiền đến sau → `late_payment` → hoàn (AT09).
 * 200 `cancel.outcome=cancelled` (gửi lại cùng khóa → kết quả cũ, header `Idempotent-Replayed`) · 409
 * NOT_AWAITING_PAYMENT (đã xác nhận/đã hủy/COD; kèm `state`) · 409 PAYMENT_NOT_UNVERIFIED (kèm `reason`) · 409
 * IDEMPOTENCY_CONFLICT · 409 BUSY_RETRY · 404 NOT_FOUND · 422 thiếu/sai lý do, mã đối chiếu, khóa.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "payment.override");
    const key = idempotencyKeyOf(req);
    const body = parseBody(CancelUnverifiedBody, req.body);
    const orderId = String(req.params.id);
    const r = await cancelUnverified(
      req.scope,
      {
        order_id: orderId,
        actor_id: actor.id,
        reason: body.reason,
        merchant_ref: body.merchant_ref,
        idempotency_key: key,
      },
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
      cancel: { outcome: r.outcome, from: r.from },
    });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
