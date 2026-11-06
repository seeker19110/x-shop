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
import { secondsToMs } from "@x-shop/domain";

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
 * IP/bản/cửa sổ ≤ hạn mức (dội 100 000 request không còn 100 000 lần ghi DB). Lượt bị chặn sớm không được đếm vào DB
 * (D-094). Ngoại lệ có chủ ý: lượt ĐANG BAY (chờ DB) vẫn tính vào chặn sớm để giữ trần ghi DB — khi DB treo, > hạn mức
 * lượt đang bay của một IP thì lượt sau nhận 429 thay vì fail-open (D-092), tự hết sau ≤ 2 cửa sổ vì ô lăn (D-098).
 */
export interface WebhookRateWindow {
  limit: number;
  windowMs: number;
}

export const WEBHOOK_RATE_LIMITS = {
  /** POST /x/webhooks/shipping/ghn: 300 callback / 10 giây / IP — đủ cho hãng gửi lặp, chặn dội request rẻ tiền. */
  ghnCallbackIp: { limit: 300, windowMs: secondsToMs(10) },
  /** GET /x/webhooks/vnpay/ipn: 300 IPN / 10 giây / IP — đủ cho VNPAY gửi lặp, chặn dội request rẻ tiền (T-152). */
  vnpayIpnIp: { limit: 300, windowMs: secondsToMs(10) },
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

/** Giữ chỗ đã ghi nhận ở bộ chặn sớm — mang theo cửa sổ lúc giữ để trả đúng ô dù cửa sổ đã lăn trong lúc chờ DB. */
export interface LocalTicket {
  bucket: string;
  start: number;
  windowMs: number;
}

export type LocalReservation =
  { blocked: false; ticket: LocalTicket | null } | { blocked: true; retryAfterSeconds: number };

/** Trần số khoá theo dõi (như `FixedWindowLimiter.maxKeys`): vượt trần → bỏ qua chặn sớm, đi thẳng tới bộ đếm chung. */
export const LOCAL_GUARD_MAX_KEYS = 10_000;

/**
 * Số lượt của RIÊNG tiến trình này đã gửi tới bộ đếm chung, theo khoá, cùng cấu trúc cửa sổ cố định + trượt. Tăng đồng
 * bộ TRƯỚC khi `await` DB nên request song song không lọt cùng lúc. Bộ nhớ có trần cứng `maxKeys`; dọn ô cũ (> 1 cửa
 * sổ) chỉ khi cần chỗ cho khoá mới và tối đa một lần mỗi cửa sổ → chi phí mỗi request O(1) (không để kẻ tấn công nhiều
 * khoá, vd IPv6 /48 = 65 536 khoá /64, biến thành O(n) mỗi request). Hết chỗ → không giữ chỗ, bộ đếm chung vẫn quyết
 * định (đúng ngữ nghĩa, chỉ mất tối ưu chặn ghi DB).
 */
export class LocalHitGuard {
  private readonly cells = new Map<string, LocalCell>();
  private lastSweepStart = -1;

  constructor(private readonly maxKeys: number = LOCAL_GUARD_MAX_KEYS) {}

  /** Số khoá đang theo dõi (test/quan sát). */
  get size(): number {
    return this.cells.size;
  }

  private sweep(windowMs: number, startNow: number): void {
    if (this.lastSweepStart === startNow) return;
    this.lastSweepStart = startNow;
    const floor = startNow - windowMs;
    for (const [k, c] of this.cells) if (c.start < floor) this.cells.delete(k);
  }

  private cell(bucket: string, windowMs: number, start: number): LocalCell | null {
    const old = this.cells.get(bucket);
    if (!old) {
      if (this.cells.size >= this.maxKeys) {
        this.sweep(windowMs, start);
        if (this.cells.size >= this.maxKeys) return null;
      }
      const fresh = { start, current: 0, previous: 0 };
      this.cells.set(bucket, fresh);
      return fresh;
    }
    if (old.start === start) return old;
    if (old.start > start) return { start, current: 0, previous: 0 }; // đồng hồ lùi: không đụng ô, không giữ chỗ
    const c = { start, current: 0, previous: old.start === start - windowMs ? old.current : 0 };
    this.cells.set(bucket, c);
    return c;
  }

  /** Lượt kế có chắc chắn bị bộ đếm chung chặn không? Không → ghi nhận lượt sắp gửi (ticket; null = không theo dõi). */
  reserve(bucket: string, limit: number, windowMs: number, now: Date): LocalReservation {
    const start = windowStartMs(windowMs, now.getTime());
    const c = this.cell(bucket, windowMs, start);
    if (!c) return { blocked: false, ticket: null };
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
    if (this.cells.get(bucket) !== c) return { blocked: false, ticket: null };
    c.current += 1;
    return { blocked: false, ticket: { bucket, start, windowMs } };
  }

  /**
   * Lượt đã giữ chỗ nhưng bộ đếm chung lỗi (không ghi được) → trả lại để chế độ "cho qua khi lỗi" không tự khoá. Cửa sổ
   * có thể đã lăn trong lúc chờ DB: ô còn ở cửa sổ lúc giữ → giảm `current`; ô đã lăn đúng 1 cửa sổ → lượt đó nay nằm ở
   * `previous`; lăn xa hơn → đã trôi hết, không còn gì để trả.
   */
  release(ticket: LocalTicket | null): void {
    if (!ticket) return;
    const c = this.cells.get(ticket.bucket);
    if (!c) return;
    if (c.start === ticket.start) {
      if (c.current > 0) c.current -= 1;
    } else if (c.start === ticket.start + ticket.windowMs && c.previous > 0) {
      c.previous -= 1;
    }
  }

  clear(): void {
    this.cells.clear();
    this.lastSweepStart = -1;
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
  let ticket: LocalTicket | null = null;
  if (guard) {
    const early = guard.reserve(bucket, limit, windowMs, now);
    if (early.blocked) return { allowed: false, retryAfterSeconds: early.retryAfterSeconds };
    ticket = early.ticket;
  }
  let sample: WindowSample;
  try {
    sample = await hit(bucket, windowMs, now);
  } catch (e) {
    guard?.release(ticket);
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
