import {
  authenticate,
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import { CheckoutError, sendProblem } from "../lib/checkout/errors";

/**
 * Chặn đường tạo đơn native `POST /store/carts/:id/complete` (completeCartWorkflow): mọi đơn phải qua checkout tùy biến
 * (giữ hàng dưới khóa, idempotency, quote, ledger — đặc tả §6.2 "Tất cả đường tạo đơn và điều chỉnh tồn phải đi qua quy
 * tắc thống nhất"; docs/design/checkout-flow.md §1).
 */
function blockNativeCartComplete(_req: MedusaRequest, res: MedusaResponse, _next: MedusaNextFunction): void {
  sendProblem(
    res,
    new CheckoutError("NOT_FOUND", "Đặt hàng qua /store/x/checkout/submit", {
      detail: { replacement: "/store/x/checkout/submit" },
    }),
  );
}

export default defineMiddlewares({
  routes: [
    {
      // Khách đăng nhập (phiên/bearer) hoặc vãng lai; quyền với giỏ kiểm trong route (assertCartAccess).
      matcher: "/store/x/checkout*",
      middlewares: [authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true })],
    },
    {
      method: ["POST"],
      matcher: "/store/carts/:id/complete",
      middlewares: [blockNativeCartComplete],
    },
  ],
});
