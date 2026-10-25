import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { actorOf, ExecuteBody, parseBody } from "../../../../../../workflows/returns/http";
import { executeRefund, presentRefund } from "../../../../../../workflows/returns/refunds";

/**
 * POST /admin/x/refunds/:id/execute — thực hiện hoàn đã duyệt (quyền `refund.execute`). Cổng: retry/timeout dùng CÙNG
 * mã yêu cầu, hỏi lại cổng trước khi gửi lại — không hoàn trùng (AT16). 200 succeeded/already_succeeded · 202 unknown
 * (gọi lại sau) · 502 failed (gọi lại để thử lại cùng mã). Hoàn ngoài hệ thống cần `evidence_ref`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.execute");
    const body = parseBody(ExecuteBody, req.body);
    const { refund, outcome } = await executeRefund(
      req.scope,
      String(req.params.id),
      actor,
      { evidence_ref: body.evidence_ref ?? null },
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    if (outcome === "unknown") res.setHeader("Retry-After", "30");
    res
      .status(outcome === "unknown" ? 202 : outcome === "failed" ? 502 : 200)
      .json({ outcome, refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
