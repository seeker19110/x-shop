import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, parseBody, RejectBody } from "../../../../../../workflows/returns/http";
import { presentRefund, rejectRefund } from "../../../../../../workflows/returns/refunds";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/** POST /admin/x/refunds/:id/reject — từ chối yêu cầu chưa duyệt, nhả số tiền đang giữ (quyền `refund.approve`). */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.approve");
    const body = parseBody(RejectBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const refund = await rejectRefund(req.scope, params.data.id, actor, body.reason, auditContextOf(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
