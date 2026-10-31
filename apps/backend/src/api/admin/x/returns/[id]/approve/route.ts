import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, DecisionBody, parseBody } from "../../../../../../workflows/returns/http";
import { approveReturn, presentReturn } from "../../../../../../workflows/returns/returns";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/returns/:id/approve — duyệt yêu cầu đổi/trả (quyền `return.approve`). Đổi size: tạo đơn thay thế liên
 * kết + giữ hàng size mới (409 INSUFFICIENT_STOCK khi hết). Gọi lại → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "return.approve");
    const body = parseBody(DecisionBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const { ret, changed } = await approveReturn(
      req.scope,
      params.data.id,
      actor,
      body.note ?? null,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ changed, return: await presentReturn(req.scope, ret, { customer: false }) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
