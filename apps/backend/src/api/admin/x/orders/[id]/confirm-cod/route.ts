import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { handleShippingRouteError } from "../../../../../../lib/shipping/http";
import { confirmCodOrder } from "../../../../../../lib/shipping/shipments";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/orders/:id/confirm-cod — nhân viên xác nhận đơn COD (đặc tả §6.3): `placed` → `confirmed` một lần,
 * outbox `order.confirmed`. Quyền `order.confirm` (khai trong `src/api/admin/x/permissions.ts`).
 * Gọi lại khi đã xác nhận → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "order.confirm");
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const r = await confirmCodOrder(req.scope, params.data.id, actorId);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(r);
  } catch (error) {
    handleShippingRouteError(req, res, error);
  }
};
