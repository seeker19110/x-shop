import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { rejectWithoutRecentMfa } from "../../../../../../lib/admin-security/guard";
import { handleReturnsRouteError, ReturnsError } from "../../../../../../workflows/returns/errors";
import { actorOf, DecisionBody, parseBody } from "../../../../../../workflows/returns/http";
import { returnsOf } from "../../../../../../workflows/returns/order-context";
import { approveRefund, presentRefund } from "../../../../../../workflows/returns/refunds";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/refunds/:id/approve — người thứ hai duyệt (quyền `refund.approve`, KHÁC người tạo → 403 SELF_APPROVAL,
 * S-403). Yêu cầu vượt ngưỡng → xác thực lại MFA ≤ 5 phút (S-402). Đã duyệt → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.approve");
    parseBody(DecisionBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const current = await returnsOf(req.scope).getRefund(params.data.id);
    if (!current) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu hoàn tiền");
    if (current.approval_required && rejectWithoutRecentMfa(req, res)) return;
    const { refund, changed } = await approveRefund(req.scope, current.id, actor, auditContextOf(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ changed, refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
