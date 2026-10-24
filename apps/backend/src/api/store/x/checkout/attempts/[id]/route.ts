import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { assertCartAccess, loadCheckoutCart } from "../../../../../../lib/checkout/cart";
import { CheckoutError } from "../../../../../../lib/checkout/errors";
import { accessContext, handleRouteError } from "../../../../../../lib/checkout/http";
import { presentAttempt } from "../../../../../../lib/checkout/submit";

/**
 * GET /store/x/checkout/attempts/:id?cart_id=… — trạng thái một lần submit (phục hồi sau timeout, đặc tả §9.1). Chỉ
 * phiên sở hữu giỏ của attempt xem được: thiếu/sai cart_id hoặc giỏ của người khác → 404 như không tồn tại.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  try {
    const cartId = typeof req.query.cart_id === "string" ? req.query.cart_id : "";
    const attemptId = String(req.params.id ?? "");
    const view = cartId && attemptId ? await presentAttempt(req.scope, attemptId) : null;
    if (!view || view.cart_id !== cartId) throw new CheckoutError("NOT_FOUND", "Không tìm thấy lần đặt hàng");
    const cart = await loadCheckoutCart(req.scope, cartId);
    try {
      assertCartAccess(cart, accessContext(req));
    } catch {
      throw new CheckoutError("NOT_FOUND", "Không tìm thấy lần đặt hàng");
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(view);
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
