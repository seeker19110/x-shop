import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { z } from "zod";
import { clientIp, handleRouteError, parseBody } from "../../../../../lib/checkout/http";
import { orderNotFound, readOrderToken, tokenHash } from "../../../../../lib/orders/access";
import { orderAccessFor, setPrivate } from "../../../../../lib/orders/http";
import { assertNotBlocked, consumeRate, recordDenied } from "../../../../../lib/orders/rate-limit";
import { CHECKOUT_MODULE } from "../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../modules/checkout/service";

const bodySchema = z.strictObject({ token: z.string().max(512) });

/**
 * POST /store/x/orders/session `{ token }` — đổi liên kết tra cứu (một lần, 15 phút) thành phiên đơn: trả
 * `{ display_ref, order_access, order_access_expires_at }` để storefront đặt cookie HttpOnly rồi chuyển tới URL không
 * chứa token. Token hết hạn/giả/đã dùng → 404 như nhau (dấu đã dùng = UNIQUE SHA-256 token ở DB → hai request đồng thời
 * chỉ một bên thắng).
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const { token } = parseBody(bodySchema, req.body);
    const ip = clientIp(req);
    const now = new Date();
    await assertNotBlocked(req.scope, "deniedIp", ip, now);
    await consumeRate(req.scope, "sessionIp", ip, now);
    const claim = readOrderToken("link", token, now);
    const s = req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const [fin] = claim ? await s.listOrderFinances({ order_id: claim.orderId }) : [];
    if (
      !claim ||
      !fin ||
      !(await s.redeemOrderAccessToken(tokenHash(token), fin.order_id, claim.expiresAt))
    ) {
      await recordDenied(req.scope, "deniedIp", ip, now);
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn("[orders] liên kết tra cứu đơn không hợp lệ (hết hạn/giả/đã dùng)");
      throw orderNotFound();
    }
    res.status(200).json({ display_ref: fin.display_ref, ...orderAccessFor(fin.order_id) });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
