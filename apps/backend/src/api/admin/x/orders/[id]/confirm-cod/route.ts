import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { handleShippingRouteError } from "../../../../../../lib/shipping/http";
import { confirmCodOrder } from "../../../../../../lib/shipping/shipments";

/**
 * POST /admin/x/orders/:id/confirm-cod — nhân viên xác nhận đơn COD (đặc tả §6.3): `placed` → `confirmed` một lần,
 * outbox `order.confirmed`. Quyền `order.confirm` (TODO RBAC: map ở `src/api/admin/x/permissions.ts` khi có).
 * Gọi lại khi đã xác nhận → 200 `changed: false`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "order.confirm");
    const r = await confirmCodOrder(req.scope, String(req.params.id), actorId);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(r);
  } catch (error) {
    handleShippingRouteError(req, res, error);
  }
};
