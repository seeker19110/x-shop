import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import {
  BatchListQuery,
  handleSettlementError,
  importSettlementBatch,
  parseInput,
  settlementOf,
} from "../../../../../lib/settlement/http";

/**
 * POST /admin/x/settlements/batches?source=ghn_cod|vnpay[&external_ref=…][&period_end=…] — nhập chứng từ đối soát
 * (quyền `settlement.import`, MFA; kho → 403). Thân: `text/csv` hoặc multipart trường `file` (định dạng nội bộ GIẢ ĐỊNH
 * — modules/settlement/constants.ts). Một dòng sai → 422 cả file. Cùng chứng từ (băm nội dung chuẩn hoá) nhập lại → 200
 * bản đã có + `Idempotent-Replayed: true`; mới → 201 kèm dòng đã đối chiếu và chênh lệch mở ra. Mã batch hãng trùng mà
 * khác nội dung → 409 BATCH_CONFLICT.
 *
 * GET /admin/x/settlements/batches — danh sách batch (quyền `settlement.read`), mới nhất trước.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "settlement.import");
    const result = await importSettlementBatch(req, actorId);
    res.setHeader("Cache-Control", "no-store");
    if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};

export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "settlement.read");
    const { limit, offset, ...filter } = parseInput(BatchListQuery, req.query);
    const { batches, count } = await settlementOf(req).listBatches(filter, { limit, offset });
    res.setHeader("Cache-Control", "no-store");
    res.json({ batches, count, limit, offset });
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
