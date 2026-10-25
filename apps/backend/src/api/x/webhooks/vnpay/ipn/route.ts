import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { vnpay } from "@x-shop/domain";
import { flattenQuery, handleVnpayIpn } from "../../../../../lib/checkout/payment";
import { FixedWindowLimiter } from "../../../../../lib/http/rate-limit";
import { clientIpOf } from "../../../../../lib/security/config";

/** 300 IPN / 10 giây / IP — đủ cho VNPAY gửi lặp, chặn dội request rẻ tiền. */
const limiter = new FixedWindowLimiter(300, 10_000);

/**
 * GET /x/webhooks/vnpay/ipn — chỉ VNPAY gọi (không cần publishable key/đăng nhập; tin cậy duy nhất là chữ ký
 * HMAC-SHA512). Phản hồi JSON `{RspCode, Message}` theo protocol (docs/design/checkout-flow.md §4, SPEC-payment S-101…S-106).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  if (!limiter.allow(clientIpOf(req).ip ?? "unknown")) {
    res.status(429).json(vnpay.IPN_RESPONSES.unknownError);
    return;
  }
  try {
    const result = await handleVnpayIpn(req.scope, flattenQuery(req.query as Record<string, unknown>));
    res.status(200).json(result);
  } catch (e) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[ipn] lỗi xử lý: ${e instanceof Error ? e.stack : JSON.stringify(e)}`);
    // 99 → VNPAY gửi lại; trạng thái không đổi vì mọi ghi đều trong transaction/idempotent.
    res.status(200).json(vnpay.IPN_RESPONSES.unknownError);
  }
};
