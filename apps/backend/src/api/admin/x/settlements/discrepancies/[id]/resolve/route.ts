import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { requirePermission } from "../../../../../../../lib/access/require-permission";
import { recordAudit } from "../../../../../../../lib/audit/record";
import {
  handleSettlementError,
  parseInput,
  ResolveBody,
  settlementOf,
} from "../../../../../../../lib/settlement/http";

/**
 * POST /admin/x/settlements/discrepancies/:id/resolve `{ note, evidence_ref? }` — đóng chênh lệch có lý do (+ mã chứng
 * từ) — quyền `exception.resolve` + `settlement.read` (kế toán). Chỉ đổi `open → resolved` một lần (lần sau 409
 * INVALID_STATE); ghi lịch sử chênh lệch + audit. Không động tới tiền: hoàn/thu hồi đi qua luồng hoàn tiền.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "exception.resolve", "settlement.read");
    const body = parseInput(ResolveBody, req.body);
    const discrepancy = await settlementOf(req).resolveDiscrepancy({
      id: String(req.params.id ?? "").slice(0, 128),
      actor_id: actorId,
      note: body.note,
      evidence_ref: body.evidence_ref ?? null,
    });
    // Lịch sử chênh lệch (cùng transaction) là bản ghi chính; audit hỏng không đảo được việc đã đóng → chỉ ghi log.
    await recordAudit(
      req.scope,
      {
        action: "settlement.discrepancy.resolved",
        resource_type: "settlement_discrepancy",
        resource_id: discrepancy.id,
        reason: body.note,
        changes: {
          kind: discrepancy.kind,
          amount: discrepancy.amount,
          evidence_ref: discrepancy.evidence_ref,
        },
      },
      req,
    ).catch((e: Error) =>
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[settlement] Không ghi được audit đóng chênh lệch: ${e.message}`),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ discrepancy });
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
