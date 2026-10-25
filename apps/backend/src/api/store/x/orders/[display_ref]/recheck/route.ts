import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";
import { CHECKOUT_CONFIG } from "../../../../../../lib/checkout/config";
import { CheckoutError } from "../../../../../../lib/checkout/errors";
import { handleRouteError } from "../../../../../../lib/checkout/http";
import { recheckAttempt } from "../../../../../../lib/checkout/recheck";
import { requireOrderAccess, setPrivate } from "../../../../../../lib/orders/http";
import { presentOrder } from "../../../../../../lib/orders/view";
import { CHECKOUT_MODULE } from "../../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../../modules/checkout/service";

/**
 * POST /store/x/orders/:display_ref/recheck — nút "Kiểm tra lại" trên trang đơn (S-104, AT08, AT24): server hỏi cổng
 * về CÙNG giao dịch (querydr) và xử lý như IPN; KHÔNG đổi trạng thái theo tham số trình duyệt, không tạo thanh toán mới.
 * Dùng chung khóa tần suất với /checkout/attempts/:id/recheck (1 lần / 10 giây mỗi lần đặt).
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const fin = await requireOrderAccess(req, "viewIpRef");
    try {
      await req.scope.resolve(Modules.LOCKING).acquire(`x-shop:recheck:${fin.checkout_attempt_id}`, {
        ownerId: randomUUID(),
        expire: CHECKOUT_CONFIG.recheckIntervalSeconds,
      });
    } catch {
      throw new CheckoutError("RATE_LIMITED", undefined, {
        detail: { retry_after_seconds: CHECKOUT_CONFIG.recheckIntervalSeconds },
      });
    }
    const check = await recheckAttempt(req.scope, fin.checkout_attempt_id);
    const [after] = await req.scope
      .resolve<CheckoutModuleService>(CHECKOUT_MODULE)
      .listOrderFinances({ order_id: fin.order_id });
    res.status(200).json({ ...(await presentOrder(req.scope, after ?? fin)), payment_check: check.outcome });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
