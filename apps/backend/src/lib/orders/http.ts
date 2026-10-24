import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { createHash } from "node:crypto";
import { clientIp } from "../checkout/http";
import { authorizedOrder, issueOrderToken, orderNotFound } from "./access";
import { assertNotBlocked, consumeRate, recordDenied } from "./rate-limit";

/** Header mang token phiên đơn (storefront đọc từ cookie HttpOnly ở server rồi gửi) — không bao giờ trên URL. */
export const ORDER_ACCESS_HEADER = "x-order-access";

/** Dữ liệu đơn là riêng tư: không cache ở trình duyệt/CDN/proxy dùng chung (AT22). */
export function setPrivate(res: MedusaResponse): void {
  res.setHeader("Cache-Control", "private, no-store");
}

/** IP rút gọn đã băm cho log (không ghi IP thô). */
const ipTag = (ip: string) => createHash("sha256").update(ip).digest("hex").slice(0, 12);

/**
 * Đơn mà request được phép thao tác (token `x-order-access` khớp mã đơn). Mọi trường hợp không được phép → 404 như
 * không tồn tại; lần bị từ chối được đếm theo IP (dò mã đơn → 429) và ghi log không PII (AT20).
 */
export async function requireOrderAccess(req: MedusaStoreRequest, rateName: "viewIpRef" | "cancelIpRef") {
  const ip = clientIp(req);
  const ref = String(req.params.display_ref ?? "");
  const now = new Date();
  await assertNotBlocked(req.scope, "deniedIp", ip, now);
  await consumeRate(req.scope, rateName, `${ip}|${ref}`, now);
  const fin = await authorizedOrder(req.scope, ref, req.get(ORDER_ACCESS_HEADER), now);
  if (!fin) {
    await recordDenied(req.scope, "deniedIp", ip, now);
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[orders] từ chối truy cập đơn ${req.method} ip#${ipTag(ip)} (token thiếu/sai/hết hạn hoặc khác đơn)`);
    throw orderNotFound();
  }
  return fin;
}

/** Token phiên đơn mới cho storefront đặt cookie (submit/đổi link). */
export function orderAccessFor(orderId: string): { order_access: string; order_access_expires_at: string } {
  const t = issueOrderToken("access", orderId);
  return { order_access: t.token, order_access_expires_at: t.expires_at };
}
