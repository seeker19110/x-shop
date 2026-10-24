import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { handleShippingRouteError, presentShipment } from "../../../../../../lib/shipping/http";
import { createShipmentForOrder } from "../../../../../../lib/shipping/shipments";

/**
 * POST /admin/x/orders/:id/shipments — tạo vận đơn GHN cho đơn đã xác nhận (SPEC-fulfillment S-302, S-303; AT11, AT13,
 * AT34). Quyền `fulfillment.create` (TODO RBAC: route đi qua `requirePermission` — điểm gắn duy nhất; agent RBAC map
 * quyền này vào `src/api/admin/x/permissions.ts` khi file đó có trên nhánh chính).
 * 201 = vừa tạo · 200 = đã có (gọi lại idempotent) · 202 = chưa rõ kết quả ở hãng (timeout) — gọi lại sau, hệ thống tra
 * theo client_order_code trước khi gửi lại.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "fulfillment.create");
    const r = await createShipmentForOrder(req.scope, String(req.params.id), actorId);
    res.setHeader("Cache-Control", "no-store");
    if (r.outcome === "pending") res.setHeader("Retry-After", "10");
    res
      .status(r.outcome === "created" ? 201 : r.outcome === "existing" ? 200 : 202)
      .json({ outcome: r.outcome, shipment: presentShipment(r.shipment) });
  } catch (error) {
    handleShippingRouteError(req, res, error);
  }
};
