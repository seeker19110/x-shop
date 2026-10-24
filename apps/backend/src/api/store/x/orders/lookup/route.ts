import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { normalizeVnPhone } from "@x-shop/domain";
import { z } from "zod";
import { CheckoutError } from "../../../../../lib/checkout/errors";
import { clientIp, handleRouteError, parseBody } from "../../../../../lib/checkout/http";
import { issueOrderToken, normalizeDisplayRef, safeEqual, tokenHash } from "../../../../../lib/orders/access";
import { setPrivate } from "../../../../../lib/orders/http";
import { consumeRate } from "../../../../../lib/orders/rate-limit";
import { CHECKOUT_MODULE } from "../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../modules/checkout/service";

const bodySchema = z.strictObject({
  display_ref: z.string().max(32),
  phone: z.string().max(32),
});

/** Thông điệp DUY NHẤT cho mọi kết quả (khớp hay không) — không lộ đơn có tồn tại (POST01, AT20). */
export const LOOKUP_ACCEPTED_MESSAGE =
  "Nếu thông tin đúng, chúng tôi đã gửi liên kết xem đơn tới số điện thoại/email đã dùng khi đặt hàng. Liên kết có hiệu lực 15 phút.";

/**
 * POST /store/x/orders/lookup `{ display_ref, phone }` → luôn 202 cùng thông điệp. Mã đơn + SĐT KHÔNG trả dữ liệu đơn;
 * khớp → tạo liên kết một lần (15 phút) và ghi outbox `order.lookup_link` (gửi thật ở T-029). Token không bao giờ nằm
 * trong phản hồi. Giới hạn: 5/giờ/SĐT, 10/giờ/mã đơn, 20/giờ/IP — đếm TRƯỚC khi tra nên 429 không lộ tồn tại.
 * Định dạng sai (không phải mã đơn/SĐT di động VN) → 422 VALIDATION (không chạm DB).
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const body = parseBody(bodySchema, req.body);
    const ref = normalizeDisplayRef(body.display_ref);
    if (!ref) throw new CheckoutError("VALIDATION", "Mã đơn hàng không hợp lệ", { field: "display_ref" });
    const phone = normalizeVnPhone(body.phone);
    if (!phone.ok) throw new CheckoutError("VALIDATION", phone.message, { field: "phone" });

    const now = new Date();
    await consumeRate(req.scope, "lookupIp", clientIp(req), now);
    await consumeRate(req.scope, "lookupPhone", phone.value, now);
    await consumeRate(req.scope, "lookupRef", ref, now);

    const s = req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const [fin] = await s.listOrderFinances({ display_ref: ref });
    const storedPhone = String((fin?.contact as { phone?: unknown } | undefined)?.phone ?? "");
    if (fin && safeEqual(storedPhone, phone.value)) {
      const link = issueOrderToken("link", fin.order_id, now);
      await s.insertOutbox(
        `order.lookup_link:${fin.order_id}:${tokenHash(link.token).slice(0, 24)}`,
        fin.order_id,
        "order.lookup_link",
        {
          order_id: fin.order_id,
          display_ref: fin.display_ref,
          // Bên gửi (T-029) dựng URL `/tra-cuu-don/xac-thuc?token=…`; token một lần, 15 phút.
          token: link.token,
          expires_at: link.expires_at,
        },
      );
    }
    res.status(202).json({ accepted: true, message: LOOKUP_ACCEPTED_MESSAGE });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
