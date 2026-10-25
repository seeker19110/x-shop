import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import {
  DiscrepancyListQuery,
  handleSettlementError,
  parseInput,
  settlementOf,
} from "../../../../../lib/settlement/http";

/**
 * GET /admin/x/settlements/discrepancies — chênh lệch đối soát kèm LỊCH SỬ (mở/tự đóng/đóng tay, ai, batch nào, khi
 * nào), lọc theo trạng thái/loại/nguồn/batch/đơn (`settlement.read`).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "settlement.read");
    const { limit, offset, ...filter } = parseInput(DiscrepancyListQuery, req.query);
    const { discrepancies, count } = await settlementOf(req).listDiscrepancies(filter, { limit, offset });
    res.setHeader("Cache-Control", "no-store");
    res.json({ discrepancies, count, limit, offset });
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
