import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { checkoutQuoteRequestSchema } from "@x-shop/domain/validation";
import { assertCartAccess, cartFingerprint, loadCheckoutCart } from "../../../../../lib/checkout/cart";
import { CHECKOUT_CONFIG, getVnpayConfig } from "../../../../../lib/checkout/config";
import { CheckoutError } from "../../../../../lib/checkout/errors";
import {
  accessContext,
  handleRouteError,
  parseCheckoutBody,
  toAddressSnapshot,
} from "../../../../../lib/checkout/http";
import { buildQuote, normalizeDiscountCode, presentQuote } from "../../../../../lib/checkout/quote";
import { CHECKOUT_MODULE } from "../../../../../modules/checkout";
import type CheckoutModuleService from "../../../../../modules/checkout/service";

/**
 * POST /store/x/checkout/quote — báo giá do server tính (S-001, CHK04, PRICE01). Body: cart_id, payment_method,
 * address {province_code, ward_code, line}, discount_code?. KHÔNG nhận giá/tổng từ client. Trả quote có id, hạn 10 phút,
 * cart_version (DATA02) và breakdown số nguyên VND.
 */
export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  try {
    // Cùng schema với form storefront (FE-FORM-001); dữ liệu sai → 422 VALIDATION có `field` + `errors[]`.
    const body = parseCheckoutBody(checkoutQuoteRequestSchema, req.body);
    const address = toAddressSnapshot(body.address);
    const cart = await loadCheckoutCart(req.scope, body.cart_id);
    assertCartAccess(cart, accessContext(req));
    if (body.payment_method === "vnpay" && !getVnpayConfig()) {
      throw new CheckoutError("VALIDATION", "Phương thức thanh toán chưa được bật", {
        field: "payment_method",
      });
    }
    const service = req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const now = new Date();
    const discountCode = normalizeDiscountCode(body.discount_code);
    const built = await buildQuote(req.scope, cart, address, discountCode, now);
    // Báo sớm (không ràng buộc) khi mã đã hết lượt; quyết định thật nằm dưới khóa lúc submit (AT33).
    if (
      built.discount?.limit != null &&
      (await service.countCountedCouponUsage(built.discount.code)) >= built.discount.limit
    ) {
      throw new CheckoutError("DISCOUNT_EXHAUSTED", undefined, { field: "discount_code" });
    }
    const { version } = await service.observeCartVersion(cart.id, cartFingerprint(cart));
    const quote = await service.createCheckoutQuotes({
      cart_id: cart.id,
      cart_version: version,
      payment_method: body.payment_method,
      discount_code: discountCode,
      address: address as unknown as Record<string, unknown>,
      breakdown: built.breakdown as unknown as Record<string, unknown>,
      shipping: built.shipping as unknown as Record<string, unknown>,
      total: built.breakdown.total,
      expires_at: new Date(now.getTime() + CHECKOUT_CONFIG.quoteTtlMs),
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      quote: presentQuote({
        ...quote,
        discount_code: quote.discount_code ?? null,
        breakdown: built.breakdown,
        address,
        shipping: built.shipping,
      }),
    });
  } catch (error) {
    handleRouteError(req, res, error);
  }
};
