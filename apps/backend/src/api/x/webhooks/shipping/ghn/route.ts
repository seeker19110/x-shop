import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { webhookRateLimit } from "../../../../../lib/http/webhook-rate-limit";
import { handleGhnCallback, ShippingError } from "../../../../../lib/shipping/shipments";

/**
 * POST /x/webhooks/shipping/ghn — GHN gọi khi vận đơn đổi trạng thái/COD (đặc tả §6.4, S-305). Không có chữ ký đáng
 * tin (chưa xác minh — docs/research mục 7) nên KHÔNG tin nội dung: lưu sự kiện đã lọc PII rồi tra lại vận đơn qua API
 * có token trước khi đổi trạng thái. Không phát minh header chữ ký. 503 = chưa xử lý xong, hãng gửi lại.
 *
 * Giới hạn 300 callback / 10 giây / IP đếm ở Postgres, chung mọi bản sao (lib/http/webhook-rate-limit.ts, T-095).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const rate = await webhookRateLimit(req, "ghnCallbackIp");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    res.status(429).json({ ok: false, code: "RATE_LIMITED" });
    return;
  }
  try {
    const r = await handleGhnCallback(req.scope, req.body);
    res.status(r.status).json(r.body);
  } catch (e) {
    if (e instanceof ShippingError && e.code === "BUSY_RETRY") {
      res.status(503).json({ ok: false, code: "BUSY_RETRY" });
      return;
    }
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[ghn-callback] lỗi xử lý: ${e instanceof Error ? e.message : "không rõ"}`);
    res.status(503).json({ ok: false, code: "INTERNAL" });
  }
};
