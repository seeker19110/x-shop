import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { assertCartAccess, loadCheckoutCart } from "../../../../../../lib/checkout/cart";
import { CheckoutError } from "../../../../../../lib/checkout/errors";
import { accessContext, handleRouteError } from "../../../../../../lib/checkout/http";
import { presentAttempt } from "../../../../../../lib/checkout/submit";
import { orderAccessFor } from "../../../../../../lib/orders/http";
import { z } from "zod";
import { IdParams, readParams, readQuery } from "../../../../../../lib/http/request-input";

/**
 * GET /store/x/checkout/attempts/:id?cart_id=… — trạng thái một lần submit (phục hồi sau timeout, đặc tả §9.1). Chỉ
 * phiên sở hữu giỏ của attempt xem được: thiếu/sai cart_id hoặc giỏ của người khác → 404 như không tồn tại.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  try {
    const params = readParams(req, IdParams);
    const query = readQuery(req, z.object({ cart_id: z.string().max(100) }));
    // Thiếu/sai kiểu cart_id hoặc id → 404 như không tồn tại (không lộ attempt có thật hay không).
    const cartId = query.ok ? query.data.cart_id : "";
    const attemptId = params.ok ? params.data.id : "";
    const view = cartId && attemptId ? await presentAttempt(req.scope, attemptId) : null;
    if (!view || view.cart_id !== cartId) throw new CheckoutError("NOT_FOUND", "Không tìm thấy lần đặt hàng");
    const cart = await loadCheckoutCart(req.scope, cartId);
    try {
      assertCartAccess(cart, accessContext(req));
    } catch {
      throw new CheckoutError("NOT_FOUND", "Không tìm thấy lần đặt hàng");
    }
    res.setHeader("Cache-Control", "no-store");
    // Đơn đã tạo → kèm token phiên đơn như 200 của submit (T-021).
    const access = view.state === "ready" && view.order ? orderAccessFor(view.order.id) : {};
    res.status(200).json({ ...view, ...access });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
