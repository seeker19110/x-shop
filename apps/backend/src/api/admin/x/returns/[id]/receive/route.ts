import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, parseBody, ReceiveBody } from "../../../../../../workflows/returns/http";
import { presentReturn, receiveReturn } from "../../../../../../workflows/returns/returns";

/**
 * POST /admin/x/returns/:id/receive — kho nhận hàng trả (quyền `return.receive`). Hàng vào KHO CÁCH LY chờ kiểm định,
 * tồn bán không đổi (AT17, INV04). `lines` bỏ trống = nhận đủ số yêu cầu. Gửi lại cùng số → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "return.receive");
    const body = parseBody(ReceiveBody, req.body);
    const { ret, changed } = await receiveReturn(
      req.scope,
      String(req.params.id),
      actor,
      body.lines ?? null,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ changed, return: await presentReturn(req.scope, ret, { customer: false }) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
