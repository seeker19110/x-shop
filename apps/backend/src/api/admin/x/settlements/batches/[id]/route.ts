import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import {
  handleSettlementError,
  settlementOf,
  SettlementHttpError,
} from "../../../../../../lib/settlement/http";

/** GET /admin/x/settlements/batches/:id — batch + từng dòng đã đối chiếu + chênh lệch mở từ batch (`settlement.read`). */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "settlement.read");
    const id = String(req.params.id ?? "");
    const detail = id.length <= 128 ? await settlementOf(req).getBatch(id) : null;
    if (!detail) throw new SettlementHttpError(404, "NOT_FOUND", "Không tìm thấy batch");
    res.setHeader("Cache-Control", "no-store");
    res.json(detail);
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
