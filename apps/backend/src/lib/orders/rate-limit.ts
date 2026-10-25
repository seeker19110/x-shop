import { createHash } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { CheckoutError } from "../checkout/errors";

/**
 * Giới hạn tần suất của các route đơn sau mua (AT20) — bộ đếm cửa sổ cố định ở Postgres, đúng cả khi nhiều instance.
 * Khóa (IP, SĐT, mã đơn) được băm trước khi lưu: bảng đếm không chứa PII thô.
 *
 * Lưu ý IP: route đọc `clientIp` (lib/security/client-ip.ts) — chỉ tin `x-forwarded-for` khi socket là proxy trong
 * `XS_TRUSTED_PROXIES` (mặc định không tin). Storefront chuyển tiếp IP khách qua `x-forwarded-for`; giới hạn theo SĐT/mã
 * đơn là chặn cứng, giới hạn theo IP là lớp phụ.
 */
export const ORDER_RATE_LIMITS = {
  /** POST /orders/lookup: mỗi SĐT 5 lần/giờ. */
  lookupPhone: { limit: 5, windowMs: 3600_000 },
  /** POST /orders/lookup: mỗi IP 20 lần/giờ. */
  lookupIp: { limit: 20, windowMs: 3600_000 },
  /** POST /orders/lookup: mỗi mã đơn 10 lần/giờ. */
  lookupRef: { limit: 10, windowMs: 3600_000 },
  /** GET /orders/:ref: mỗi (IP, mã đơn) 60 lần / 10 phút. */
  viewIpRef: { limit: 60, windowMs: 600_000 },
  /** Lần truy cập đơn BỊ TỪ CHỐI (token sai/thiếu, mã khác) mỗi IP 20 lần / 10 phút — chặn dò mã đơn. */
  deniedIp: { limit: 20, windowMs: 600_000 },
  /** POST /orders/session: mỗi IP 20 lần / 10 phút. */
  sessionIp: { limit: 20, windowMs: 600_000 },
  /** POST /orders/:ref/cancel: mỗi (IP, mã đơn) 10 lần / 10 phút. */
  cancelIpRef: { limit: 10, windowMs: 600_000 },
} as const;

export type OrderRateLimit = keyof typeof ORDER_RATE_LIMITS;

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

const bucketOf = (name: OrderRateLimit, key: string) =>
  `orders.${name}:${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40)}`;

function rateLimited(name: OrderRateLimit): CheckoutError {
  const windowS = Math.ceil(ORDER_RATE_LIMITS[name].windowMs / 1000);
  return new CheckoutError("RATE_LIMITED", "Bạn đã thử quá nhiều lần, vui lòng thử lại sau", {
    detail: { retry_after_seconds: Math.min(windowS, 3600) },
  });
}

/** Đếm một lượt; vượt hạn mức → ném RATE_LIMITED (429). */
export async function consumeRate(
  container: MedusaContainer,
  name: OrderRateLimit,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const { limit, windowMs } = ORDER_RATE_LIMITS[name];
  const count = await service(container).hitRateCounter(bucketOf(name, key), windowMs, now);
  if (count > limit) throw rateLimited(name);
}

/** Chỉ kiểm (không đếm) — dùng với `recordDenied` cho giới hạn số lần bị từ chối. */
export async function assertNotBlocked(
  container: MedusaContainer,
  name: OrderRateLimit,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const { limit, windowMs } = ORDER_RATE_LIMITS[name];
  const count = await service(container).peekRateCounter(bucketOf(name, key), windowMs, now);
  if (count >= limit) throw rateLimited(name);
}

export async function recordDenied(
  container: MedusaContainer,
  name: OrderRateLimit,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  await service(container).hitRateCounter(bucketOf(name, key), ORDER_RATE_LIMITS[name].windowMs, now);
}
