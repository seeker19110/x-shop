import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { handleRouteError } from "../../../../../lib/checkout/http";
import { requireOrderAccess, setPrivate } from "../../../../../lib/orders/http";
import { presentOrder } from "../../../../../lib/orders/view";

/**
 * GET /store/x/orders/:display_ref — header `x-order-access: <token phiên đơn>` (storefront gửi từ cookie HttpOnly).
 * Token thiếu/sai/hết hạn hoặc của đơn khác → 404 như không tồn tại (AT20); giới hạn tần suất theo (IP, mã đơn) và số
 * lần bị từ chối theo IP. Trả đơn: state / payment_state / shipment_state tách riêng + timeline (CHK06, POST01).
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const fin = await requireOrderAccess(req, "viewIpRef");
    res.status(200).json(await presentOrder(req.scope, fin));
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
