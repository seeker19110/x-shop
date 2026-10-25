import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, parseBody, RejectBody } from "../../../../../../workflows/returns/http";
import { presentReturn, rejectReturn } from "../../../../../../workflows/returns/returns";

/** POST /admin/x/returns/:id/reject — từ chối yêu cầu đang chờ duyệt, bắt buộc lý do (quyền `return.approve`). */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "return.approve");
    const body = parseBody(RejectBody, req.body);
    const ret = await rejectReturn(req.scope, String(req.params.id), actor, body.reason, auditContextOf(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ return: await presentReturn(req.scope, ret, { customer: false }) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
