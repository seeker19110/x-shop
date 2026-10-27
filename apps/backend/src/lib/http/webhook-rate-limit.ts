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
  sampleAt,
  slidingRetryAfterSeconds,
  windowStartMs,
  wouldExceedLimit,
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
 *
 * Chặn sớm trong bộ nhớ (T-152): mỗi bản sao nhớ số lượt NÓ đã gửi tới bộ đếm chung trong cửa sổ. Chỉ khi riêng số đó đã
 * vượt hạn mức (hiệu dụng + 1 > limit) mới trả 429 không chạm DB. Bộ đếm chung ≥ số đếm cục bộ của mọi bản sao, nên
 * lượt bị chặn sớm chắc chắn cũng bị bộ đếm chung chặn — kết quả cho/chặn không đổi; chỉ giới hạn số UPSERT mỗi
 * IP/bản/cửa sổ ≤ hạn mức (dội 100 000 request không còn 100 000 lần ghi DB). Lượt bị chặn sớm không được đếm vào DB.
 */
export interface WebhookRateWindow {
  limit: number;
  windowMs: number;
}

export const WEBHOOK_RATE_LIMITS = {
  /** POST /x/webhooks/shipping/ghn: 300 callback / 10 giây / IP — đủ cho hãng gửi lặp, chặn dội request rẻ tiền. */
  ghnCallbackIp: { limit: 300, windowMs: 10_000 },
  /** GET /x/webhooks/vnpay/ipn: 300 IPN / 10 giây / IP — đủ cho VNPAY gửi lặp, chặn dội request rẻ tiền (T-152). */
  vnpayIpnIp: { limit: 300, windowMs: 10_000 },
} as const satisfies Record<string, WebhookRateWindow>;

export type WebhookRateLimit = keyof typeof WEBHOOK_RATE_LIMITS;

/** Đếm một lượt rồi trả mẫu (= `CheckoutModuleService.hitRateCounter`). */
export type WindowHit = (bucket: string, windowMs: number, now: Date) => Promise<WindowSample>;

export type WebhookRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Khoá bộ đếm của chính sách `name` cho IP `ip` (đã băm). */
export function webhookRateBucket(name: WebhookRateLimit, ip: string): string {
  return `webhook.${name}:${createHash("sha256").update(ipRateKey(ip), "utf8").digest("hex").slice(0, 40)}`;
}

interface LocalCell {
  start: number;
  current: number;
  previous: number;
}

/**
 * Số lượt của RIÊNG tiến trình này đã gửi tới bộ đếm chung, theo khoá, cùng cấu trúc cửa sổ cố định + trượt. Tăng đồng
 * bộ TRƯỚC khi `await` DB nên request song song không lọt cùng lúc. Ô quá 2 cửa sổ bị dọn khi truy cập (bộ nhớ ≤ số
 * khoá hoạt động trong 2 cửa sổ).
 */
export class LocalHitGuard {
  private readonly cells = new Map<string, LocalCell>();

  private cell(bucket: string, windowMs: number, now: Date): LocalCell {
    const start = windowStartMs(windowMs, now.getTime());
    const old = this.cells.get(bucket);
    let c: LocalCell;
    if (!old || old.start > start) c = { start, current: 0, previous: 0 };
    else if (old.start === start) c = old;
    else c = { start, current: 0, previous: old.start === start - windowMs ? old.current : 0 };
    this.cells.set(bucket, c);
    return c;
  }

  private sweep(windowMs: number, now: Date): void {
    if (this.cells.size < 1024) return;
    const floor = windowStartMs(windowMs, now.getTime()) - windowMs;
    for (const [k, c] of this.cells) if (c.start < floor) this.cells.delete(k);
  }

  /** Lượt kế có chắc chắn bị bộ đếm chung chặn không? Không → ghi nhận lượt sắp gửi (đã tăng). */
  reserve(
    bucket: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): { blocked: false } | { blocked: true; retryAfterSeconds: number } {
    this.sweep(windowMs, now);
    const c = this.cell(bucket, windowMs, now);
    const sample: WindowSample = sampleAt(c, windowMs, now);
    if (wouldExceedLimit(sample, limit, windowMs)) {
      // Như bộ đếm chung sẽ tính sau khi đếm lượt này (current + 1) — khớp tuyệt đối khi chỉ bản này đóng góp, ngắn hơn
      // (không bao giờ dài hơn) khi bản khác cũng đóng góp.
      const afterHit: WindowSample = { ...sample, current: sample.current + 1 };
      return {
        blocked: true,
        retryAfterSeconds: slidingRetryAfterSeconds(afterHit, limit, windowMs, NEXT_HIT),
      };
    }
    c.current += 1;
    return { blocked: false };
  }

  /** Lượt đã giữ chỗ nhưng bộ đếm chung lỗi (không ghi được) → trả lại để chế độ "cho qua khi lỗi" không tự khoá. */
  release(bucket: string, windowMs: number, now: Date): void {
    const c = this.cells.get(bucket);
    if (c && c.start === windowStartMs(windowMs, now.getTime()) && c.current > 0) c.current -= 1;
  }

  clear(): void {
    this.cells.clear();
  }
}

/** Bộ chặn sớm của tiến trình (dùng chung cho mọi route webhook). Test gọi `clear()`. */
export const localHitGuard = new LocalHitGuard();

/**
 * Đếm một lượt của `ip` theo chính sách `name`; bộ đếm lỗi → cho qua (gọi `onCounterError`). `guard` = chặn sớm trong
 * bộ nhớ (mặc định: bộ của tiến trình); truyền `null` để tắt (test đối chứng).
 */
export async function consumeWebhookRate(
  hit: WindowHit,
  name: WebhookRateLimit,
  ip: string,
  now: Date,
  onCounterError: (e: unknown) => void = () => {},
  guard: LocalHitGuard | null = localHitGuard,
): Promise<WebhookRateDecision> {
  const { limit, windowMs } = WEBHOOK_RATE_LIMITS[name];
  const bucket = webhookRateBucket(name, ip);
  if (guard) {
    const early = guard.reserve(bucket, limit, windowMs, now);
    if (early.blocked) return { allowed: false, retryAfterSeconds: early.retryAfterSeconds };
  }
  let sample: WindowSample;
  try {
    sample = await hit(bucket, windowMs, now);
  } catch (e) {
    guard?.release(bucket, windowMs, now);
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
