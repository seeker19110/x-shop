import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { isValidIdempotencyKey } from "@x-shop/domain";
import { assertCartAccess, loadCheckoutCart } from "../../../../../lib/checkout/cart";
import { getVnpayConfig } from "../../../../../lib/checkout/config";
import { CheckoutError, sendProblem } from "../../../../../lib/checkout/errors";
import {
  accessContext,
  clientIp,
  handleRouteError,
  normalizeContact,
  parseBody,
  submitBodySchema,
  toAddressSnapshot,
} from "../../../../../lib/checkout/http";
import { submitCheckout } from "../../../../../lib/checkout/submit";
import { orderAccessFor } from "../../../../../lib/orders/http";

/**
 * POST /store/x/checkout/submit — header `Idempotency-Key` (16–128 ký tự [A-Za-z0-9_-]); body: cart_id, cart_version,
 * quote_id, payment_method (cod|vnpay), contact {name, phone, email?}, address {province_code, ward_code, line}.
 * 200 = đơn đã tạo (COD `placed` / VNPAY `awaiting_payment` + payment_url); 202 = đang xử lý (xem Location);
 * lỗi = application/problem+json với `code` ổn định (đặc tả §9.1). 200 kèm `order_access` + `order_access_expires_at`
 * (token phiên đơn, T-021) để storefront đặt cookie HttpOnly xem `/don-hang/:ref`.
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  try {
    const key = req.get("Idempotency-Key");
    if (!isValidIdempotencyKey(key)) {
      throw new CheckoutError("VALIDATION", "Thiếu hoặc sai Idempotency-Key", { field: "Idempotency-Key" });
    }
    const body = parseBody(submitBodySchema, req.body);
    const contact = normalizeContact(body.contact);
    const address = toAddressSnapshot(body.address);
    const access = accessContext(req);
    const cart = await loadCheckoutCart(req.scope, body.cart_id);
    assertCartAccess(cart, access);
    if (body.payment_method === "vnpay" && !getVnpayConfig()) {
      throw new CheckoutError("VALIDATION", "Phương thức thanh toán chưa được bật", {
        field: "payment_method",
      });
    }

    const outcome = await submitCheckout(req.scope, {
      idempotency_key: key,
      cart_id: cart.id,
      cart_version: body.cart_version,
      quote_id: body.quote_id,
      payment_method: body.payment_method,
      contact,
      address,
      customer_id: access.actorId !== null && access.actorId === cart.customer_id ? access.actorId : null,
      ip: clientIp(req),
    });

    res.setHeader("Cache-Control", "no-store");
    if (outcome.kind === "error") {
      if (outcome.attemptId) res.setHeader("X-Checkout-Attempt-Id", outcome.attemptId);
      sendProblem(res, outcome.error);
      return;
    }
    const statusUrl = `/store/x/checkout/attempts/${outcome.view.checkout_attempt_id}?cart_id=${encodeURIComponent(cart.id)}`;
    if (outcome.kind === "pending") {
      res.setHeader("Location", statusUrl);
      res.setHeader("Retry-After", "1");
      res.status(202).json({ ...outcome.view, status_url: statusUrl });
      return;
    }
    // Phiên đơn (POST01): token ngắn hạn để storefront đổi thành cookie HttpOnly — không bao giờ đặt trên URL.
    const orderAccess = outcome.view.order ? orderAccessFor(outcome.view.order.id) : {};
    res.status(200).json({ ...outcome.view, status_url: statusUrl, ...orderAccess });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
