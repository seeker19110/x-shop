import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import {
  handleSettlementError,
  settlementOf,
  SettlementHttpError,
} from "../../../../../../lib/settlement/http";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/** GET /admin/x/settlements/batches/:id — batch + từng dòng đã đối chiếu + chênh lệch mở từ batch (`settlement.read`). */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "settlement.read");
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const detail = await settlementOf(req).getBatch(params.data.id);
    if (!detail) throw new SettlementHttpError(404, "NOT_FOUND", "Không tìm thấy batch");
    res.setHeader("Cache-Control", "no-store");
    res.json(detail);
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
