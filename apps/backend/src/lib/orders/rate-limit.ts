import { createHash } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { CheckoutError } from "../checkout/errors";
import {
  exceedsLimit,
  NEXT_HIT,
  slidingRetryAfterSeconds,
  wouldExceedLimit,
  type WindowSample,
} from "../security/sliding-window";

/**
 * Giới hạn tần suất của các route đơn sau mua (AT20) — bộ đếm ở Postgres, đúng cả khi nhiều instance; quyết định theo
 * xấp xỉ cửa sổ trượt (lib/security/sliding-window.ts, T-055): dò mã/SĐT vắt qua ranh giới cửa sổ vẫn bị chặn đúng ngưỡng.
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

/** RATE_LIMITED kèm `Retry-After` = lúc lượt kế tiếp (được đếm) được cho qua, giả định không thử thêm. */
function rateLimited(name: OrderRateLimit, sample: WindowSample): CheckoutError {
  const { limit, windowMs } = ORDER_RATE_LIMITS[name];
  return new CheckoutError("RATE_LIMITED", "Bạn đã thử quá nhiều lần, vui lòng thử lại sau", {
    detail: { retry_after_seconds: slidingRetryAfterSeconds(sample, limit, windowMs, NEXT_HIT) },
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
  const sample = await service(container).hitRateCounter(bucketOf(name, key), windowMs, now);
  if (exceedsLimit(sample, limit, windowMs)) throw rateLimited(name, sample);
}

/** Chỉ kiểm (không đếm) — dùng với `recordDenied` cho giới hạn số lần bị từ chối. */
export async function assertNotBlocked(
  container: MedusaContainer,
  name: OrderRateLimit,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const { limit, windowMs } = ORDER_RATE_LIMITS[name];
  const sample = await service(container).peekRateCounter(bucketOf(name, key), windowMs, now);
  if (wouldExceedLimit(sample, limit, windowMs)) throw rateLimited(name, sample);
}

export async function recordDenied(
  container: MedusaContainer,
  name: OrderRateLimit,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  await service(container).hitRateCounter(bucketOf(name, key), ORDER_RATE_LIMITS[name].windowMs, now);
}
