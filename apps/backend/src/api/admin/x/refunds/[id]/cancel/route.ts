import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, CancelBody, parseBody } from "../../../../../../workflows/returns/http";
import { cancelRefund, presentRefund } from "../../../../../../workflows/returns/refunds";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/refunds/:id/cancel — hủy yêu cầu hoàn đã thất bại (quyền `refund.execute`, `reason` bắt buộc — T-044):
 * nhả số đang giữ để tạo yêu cầu mới. Hoàn qua cổng được đối chiếu cùng mã trước khi hủy. 200 `changed` true/false
 * (đã hủy → trả nguyên) · 409 INVALID_STATE (không ở `failed`, hoặc cổng báo đã hoàn) · 409 REFUND_PROVIDER_UNCONFIRMED.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.execute");
    const body = parseBody(CancelBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const { refund, changed } = await cancelRefund(
      req.scope,
      params.data.id,
      actor,
      body.reason,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ changed, refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
