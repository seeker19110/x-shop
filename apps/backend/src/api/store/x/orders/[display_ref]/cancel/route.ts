import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { handleRouteError } from "../../../../../../lib/checkout/http";
import { cancelByCustomer } from "../../../../../../lib/orders/cancel";
import { requireOrderAccess, setPrivate } from "../../../../../../lib/orders/http";
import { presentOrder } from "../../../../../../lib/orders/view";
import { CHECKOUT_MODULE } from "../../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../../modules/checkout/service";

/**
 * POST /store/x/orders/:display_ref/cancel — header `x-order-access`. Hủy khi trạng thái cho phép (POST02, S-309);
 * idempotent: gọi lại trên đơn đã hủy → 200 `cancel.outcome = already_cancelled`. Đơn đã thu tiền → mở yêu cầu hoàn
 * tiền (`cancel.refund_requested`). 409 NOT_CANCELLABLE (đã có vận đơn / trạng thái kết thúc) · 409 PAYMENT_PENDING.
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const fin = await requireOrderAccess(req, "cancelIpRef");
    const cancel = await cancelByCustomer(req.scope, fin.order_id);
    const [after] = await req.scope
      .resolve<CheckoutModuleService>(CHECKOUT_MODULE)
      .listOrderFinances({ order_id: fin.order_id });
    res.status(200).json({ ...(await presentOrder(req.scope, after ?? fin)), cancel });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
