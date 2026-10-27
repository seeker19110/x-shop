import { createHash } from "node:crypto";
import type { MedusaRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { ipRateKey } from "../security/client-ip";
import { clientIpOf } from "../security/config";
import {
  exceedsLimit,
  NEXT_HIT,
  slidingRetryAfterSeconds,
  type WindowSample,
} from "../security/sliding-window";

/**
 * Giới hạn tần suất webhook công khai, DÙNG CHUNG mọi bản sao backend (T-095, ARC-RES-005): bộ đếm ở Postgres
 * (`rate_limit_counter` qua `hitRateCounter` — UPSERT nguyên tử, có job dọn), cùng kho với mọi rate limit Store/đơn/audit.
 * Thay `FixedWindowLimiter` trong bộ nhớ tiến trình: chạy N bản sao thì mỗi bản đếm riêng → hạn mức thật thành N×.
 *
 * Quyết định theo xấp xỉ cửa sổ trượt (lib/security/sliding-window.ts, D-034/D-037) như mọi rate limit khác; "tăng rồi
 * so": N request song song (kể cả rải qua nhiều bản sao) nhận N giá trị đếm khác nhau → đúng `limit` request lọt mỗi
 * cửa sổ. `Retry-After` = lúc lượt kế tiếp được qua (≥ 1 giây, có thể tới 2 cửa sổ sau đợt dội).
 *
 * Bộ đếm lỗi (DB) → CHO QUA và log cảnh báo, như rate limit Store (lib/security/rate-limit.ts): handler webhook vẫn
 * idempotent (khoá sự kiện duy nhất, tra lại hãng trước khi đổi trạng thái); chặn webhook hợp lệ vì lỗi đếm tệ hơn.
 * Khoá theo IP (`ipRateKey`: IPv6 gộp /64) được băm — bảng đếm không chứa IP thô.
 */
export interface WebhookRateWindow {
  limit: number;
  windowMs: number;
}

export const WEBHOOK_RATE_LIMITS = {
  /** POST /x/webhooks/shipping/ghn: 300 callback / 10 giây / IP — đủ cho hãng gửi lặp, chặn dội request rẻ tiền. */
  ghnCallbackIp: { limit: 300, windowMs: 10_000 },
} as const satisfies Record<string, WebhookRateWindow>;

export type WebhookRateLimit = keyof typeof WEBHOOK_RATE_LIMITS;

/** Đếm một lượt rồi trả mẫu (= `CheckoutModuleService.hitRateCounter`). */
export type WindowHit = (bucket: string, windowMs: number, now: Date) => Promise<WindowSample>;

export type WebhookRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Khoá bộ đếm của chính sách `name` cho IP `ip` (đã băm). */
export function webhookRateBucket(name: WebhookRateLimit, ip: string): string {
  return `webhook.${name}:${createHash("sha256").update(ipRateKey(ip), "utf8").digest("hex").slice(0, 40)}`;
}

/** Đếm một lượt của `ip` theo chính sách `name`; bộ đếm lỗi → cho qua (gọi `onCounterError`). */
export async function consumeWebhookRate(
  hit: WindowHit,
  name: WebhookRateLimit,
  ip: string,
  now: Date,
  onCounterError: (e: unknown) => void = () => {},
): Promise<WebhookRateDecision> {
  const { limit, windowMs } = WEBHOOK_RATE_LIMITS[name];
  let sample: WindowSample;
  try {
    sample = await hit(webhookRateBucket(name, ip), windowMs, now);
  } catch (e) {
    onCounterError(e);
    return { allowed: true };
  }
  return exceedsLimit(sample, limit, windowMs)
    ? { allowed: false, retryAfterSeconds: slidingRetryAfterSeconds(sample, limit, windowMs, NEXT_HIT) }
    : { allowed: true };
}

/**
 * Kiểm giới hạn `name` cho request webhook. IP không xác định → chung một khoá "unknown" (chặt: không có IP thì không
 * lách được bằng cách giấu IP).
 */
export async function webhookRateLimit(
  req: MedusaRequest,
  name: WebhookRateLimit,
  now: Date = new Date(),
): Promise<WebhookRateDecision> {
  const ip = clientIpOf(req).ip ?? "unknown";
  const warn = (e: unknown) =>
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[webhook] Bộ đếm rate limit ${name} lỗi, cho qua: ${e instanceof Error ? e.message : "không rõ"}`,
      );
  const hit: WindowHit = (bucket, windowMs, at) =>
    req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE).hitRateCounter(bucket, windowMs, at);
  return consumeWebhookRate(hit, name, ip, now, warn);
}
