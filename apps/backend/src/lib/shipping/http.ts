import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { logServerError } from "../errors/error-handler";
import type { ShipmentRow } from "../../modules/shipping/service";
import { readCheckoutError, sendProblem as sendCheckoutProblem } from "../checkout/errors";
import { sendProblem } from "../http/problem";
import { ShippingError } from "./shipments";

/** Hình vận đơn trả Admin API — KHÔNG gồm `label_url` (nhãn chứa dữ liệu người nhận, đi đường truy cập riêng). */
export function presentShipment(s: ShipmentRow) {
  return {
    id: s.id,
    order_id: s.order_id,
    client_order_code: s.client_order_code,
    provider: s.provider,
    provider_order_code: s.provider_order_code,
    state: s.state,
    cod_amount: s.cod_amount,
    shipping_fee: s.shipping_fee,
    payer: s.payer,
    created_by: s.created_by,
    settlement_state: s.settlement_state,
    cod_reported_amount: s.cod_reported_amount,
    cod_reported_at: s.cod_reported_at?.toISOString() ?? null,
    delivered_at: s.delivered_at?.toISOString() ?? null,
  };
}

/** Lỗi route Admin giao vận → problem+json; lỗi quyền của Medusa giữ nguyên mã (401/403). */
export function handleShippingRouteError(req: MedusaRequest, res: MedusaResponse, error: unknown): void {
  if (error instanceof ShippingError) {
    if (error.code === "BUSY_RETRY" || error.code === "PROVIDER_UNAVAILABLE")
      res.setHeader("Retry-After", "2");
    return sendProblem(res, error.status, error.code, error.message, [], error.detail);
  }
  // Hạ tầng khóa (Redis) hỏng/không trả lời → 503 LOCK_UNAVAILABLE + Retry-After như route checkout.
  const checkout = readCheckoutError(error);
  if (checkout && checkout.code !== "INTERNAL") return sendCheckoutProblem(res, checkout);
  if (error instanceof MedusaError) {
    const status =
      error.type === MedusaError.Types.UNAUTHORIZED
        ? 401
        : error.type === MedusaError.Types.NOT_ALLOWED
          ? 403
          : 0;
    if (status) return sendProblem(res, status, error.type.toUpperCase(), error.message);
  }
  logServerError(req, "shipping", error);
  sendProblem(res, 500, "INTERNAL", "Không thể xử lý yêu cầu lúc này");
}
