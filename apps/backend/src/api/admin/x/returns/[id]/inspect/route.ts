import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, InspectBody, parseBody } from "../../../../../../workflows/returns/http";
import { presentRefund } from "../../../../../../workflows/returns/refunds";
import { inspectReturn, presentReturn } from "../../../../../../workflows/returns/returns";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/returns/:id/inspect — kết quả kiểm định từng dòng (quyền `return.inspect`, INV04, AT15–AT17): đạt →
 * nhập lại tồn bán (một lần), lỗi → ở lại kho cách ly, còn lại = không đạt (trả lại khách). Trả hàng → mở yêu cầu hoàn
 * theo giá thực trả; đổi size → xác nhận/hủy đơn thay thế. Gửi lại cùng kết quả → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "return.inspect");
    const body = parseBody(InspectBody, req.body);
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const { ret, refund, changed } = await inspectReturn(
      req.scope,
      params.data.id,
      actor,
      body.lines,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      changed,
      return: await presentReturn(req.scope, ret, { customer: false }),
      refund: refund ? presentRefund(refund) : null,
    });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
