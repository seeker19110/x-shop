import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { auditContextOf } from "../../../../../../lib/audit/record";
import { handleShippingRouteError, presentShipment } from "../../../../../../lib/shipping/http";
import { createShipmentForOrder } from "../../../../../../lib/shipping/shipments";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/orders/:id/shipments — tạo vận đơn GHN cho đơn đã xác nhận (SPEC-fulfillment S-302, S-303; AT11, AT13,
 * AT34). Quyền `fulfillment.create` (khai trong src/api/admin/x/permissions.ts — RBAC chặn trước khi vào handler).
 * 201 = vừa tạo · 200 = đã có (gọi lại idempotent) · 202 = chưa rõ kết quả ở hãng (timeout) — gọi lại sau, hệ thống tra
 * theo client_order_code trước khi gửi lại. Hãng đã nhận → fulfillment native + trừ tồn một lần (T-043); chưa ghi nhận
 * xuất kho được → 409 FULFILLMENT_BLOCKED (vận đơn vẫn giữ, gọi lại an toàn).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actorId = requirePermission(req, "fulfillment.create");
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const r = await createShipmentForOrder(req.scope, params.data.id, actorId, auditContextOf(req));
    res.setHeader("Cache-Control", "no-store");
    // Không sớm hơn 10 giây; hãng yêu cầu chờ lâu hơn (429 Retry-After) thì theo hãng (T-093).
    if (r.outcome === "pending") res.setHeader("Retry-After", String(Math.max(10, r.retryAfterSeconds ?? 0)));
    res
      .status(r.outcome === "created" ? 201 : r.outcome === "existing" ? 200 : 202)
      .json({ outcome: r.outcome, shipment: presentShipment(r.shipment) });
  } catch (error) {
    handleShippingRouteError(req, res, error);
  }
};
