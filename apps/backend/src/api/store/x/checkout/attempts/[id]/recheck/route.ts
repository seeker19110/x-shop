import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";
import { assertCartAccess, loadCheckoutCart } from "../../../../../../../lib/checkout/cart";
import { CHECKOUT_CONFIG } from "../../../../../../../lib/checkout/config";
import { CheckoutError } from "../../../../../../../lib/checkout/errors";
import { accessContext, handleRouteError } from "../../../../../../../lib/checkout/http";
import { recheckAttempt } from "../../../../../../../lib/checkout/recheck";
import { presentAttempt } from "../../../../../../../lib/checkout/submit";

/**
 * POST /store/x/checkout/attempts/:id/recheck?cart_id=… — nút "Kiểm tra lại" sau khi khách quay về từ VNPAY (S-104,
 * AT08). Chỉ phiên sở hữu giỏ; tối đa 1 lần / 10 giây mỗi attempt (khóa có hạn trong Redis — đúng cả khi nhiều
 * instance). Server hỏi VNPAY (querydr) và xử lý như IPN; KHÔNG đổi trạng thái theo tham số trình duyệt gửi lên.
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  try {
    const body = (req.body ?? {}) as { cart_id?: unknown };
    const cartId =
      typeof req.query.cart_id === "string"
        ? req.query.cart_id
        : typeof body.cart_id === "string"
          ? body.cart_id
          : "";
    const attemptId = String(req.params.id ?? "");
    const notFound = () => new CheckoutError("NOT_FOUND", "Không tìm thấy lần đặt hàng");
    const before = cartId && attemptId ? await presentAttempt(req.scope, attemptId) : null;
    if (!before || before.cart_id !== cartId) throw notFound();
    try {
      assertCartAccess(await loadCheckoutCart(req.scope, cartId), accessContext(req));
    } catch {
      throw notFound();
    }
    try {
      // Khóa không bao giờ nhả, tự hết hạn sau 10 giây = giới hạn tần suất phân tán.
      await req.scope.resolve(Modules.LOCKING).acquire(`x-shop:recheck:${attemptId}`, {
        ownerId: randomUUID(),
        expire: CHECKOUT_CONFIG.recheckIntervalSeconds,
      });
    } catch {
      throw new CheckoutError("RATE_LIMITED", undefined, {
        detail: { retry_after_seconds: CHECKOUT_CONFIG.recheckIntervalSeconds },
      });
    }
    const check = await recheckAttempt(req.scope, attemptId);
    const view = await presentAttempt(req.scope, attemptId);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...view, payment_check: check.outcome });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
