import { createHash } from "node:crypto";
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { parseFilter } from "@x-shop/domain";
import { CheckoutError, sendProblem } from "../checkout/errors";
import { sanitizeQuery } from "../catalog/listing";
import { ipRateKey } from "./client-ip";
import { clientIpOf } from "./config";
import {
  exceedsLimit,
  NEXT_HIT,
  slidingRetryAfterSeconds,
  type NextRequestRule,
  type WindowSample,
} from "./sliding-window";

export * from "./sliding-window";

/**
 * Rate limit route công khai của Store API (SEC03): tìm kiếm, mã giảm giá (quote), đặt hàng (submit). Tra cứu đơn
 * (`/store/x/orders/*`) đã có giới hạn riêng trong route (lib/orders/rate-limit.ts, AT20).
 *
 * Nhiều tín hiệu, tránh khoá cả mạng dùng chung: theo IP (ngưỡng rộng) VÀ theo khoá nghiệp vụ (giỏ — ngưỡng hẹp).
 * Bộ đếm ở Postgres (`rate_limit_counter`, UPSERT nguyên tử, chung mọi instance, có job dọn) lưu theo cửa sổ cố định,
 * quyết định theo XẤP XỈ CỬA SỔ TRƯỢT (sliding-window.ts, T-055): số hiệu dụng = cửa sổ hiện tại + cửa sổ trước × phần
 * còn lại — không còn 2× hạn mức quanh ranh giới. Khoá được băm — bảng đếm không chứa IP/mã/giỏ thô.
 *
 * "Tăng rồi so" (không "đọc rồi tăng"): N request song song nhận N giá trị đếm khác nhau → đúng `limit` request lọt.
 *
 * Mã giảm giá / Idempotency-Key đếm theo SỐ GIÁ TRỊ KHÁC NHAU trong cửa sổ: báo giá lại với cùng mã (đổi địa chỉ, đổi
 * phương thức) hay gửi lại cùng khoá (thử lại mạng, BUSY_RETRY) không tốn lượt; dò mã / đổi khoá liên tục thì tốn. Khi bộ
 * đếm đã vượt ngưỡng, mọi request của khoá đó bị chặn tới khi số hiệu dụng hạ xuống (kể cả giá trị đã thấy). "Đã thấy"
 * xét trong cửa sổ hiện tại: cùng giá trị dùng lại sau ranh giới tốn thêm một lượt (chặt hơn, không bao giờ lỏng hơn).
 */
export interface RateWindow {
  limit: number;
  windowMs: number;
}

export const STORE_RATE_LIMITS = {
  /** GET /store/x/search: mỗi IP 60 lần/phút. */
  searchIp: { limit: 60, windowMs: 60_000 },
  /** POST /store/x/checkout/quote: mỗi IP 60 lần/phút. */
  quoteIp: { limit: 60, windowMs: 60_000 },
  /** Mã giảm giá KHÁC NHAU mỗi IP / giờ. */
  couponIp: { limit: 30, windowMs: 3_600_000 },
  /** Mã giảm giá KHÁC NHAU mỗi giỏ / giờ. */
  couponCart: { limit: 10, windowMs: 3_600_000 },
  /** Idempotency-Key KHÁC NHAU (lần đặt mới) mỗi IP / 10 phút. */
  submitIp: { limit: 20, windowMs: 600_000 },
  /** Idempotency-Key KHÁC NHAU mỗi giỏ / 10 phút. */
  submitCart: { limit: 10, windowMs: 600_000 },
} as const satisfies Record<string, RateWindow>;

export type StoreRateLimit = keyof typeof STORE_RATE_LIMITS;

/**
 * Bộ đếm theo cửa sổ cố định: `hit` tăng rồi trả mẫu (cửa sổ hiện tại sau khi tăng + cửa sổ trước, đọc nguyên tử, kèm
 * `elapsedMs` của `now`); `peek` chỉ đọc. `now` tiêm ở đây là mốc duy nhất của quyết định.
 */
export interface RateCounter {
  hit(bucket: string, windowMs: number, now: Date): Promise<WindowSample>;
  peek(bucket: string, windowMs: number, now: Date): Promise<WindowSample>;
}

export type RateDecision =
  { allowed: true } | { allowed: false; policy: StoreRateLimit; retryAfterSeconds: number };

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 40);
const bucketOf = (name: StoreRateLimit, key: string) => `sec.${name}:${digest(key)}`;

/** `Retry-After` (giây, ≥ 1) của chính sách `name`: lúc request kế tiếp (theo `rule`) được cho qua. */
export function retryAfterSeconds(
  name: StoreRateLimit,
  sample: WindowSample,
  rule: NextRequestRule = NEXT_HIT,
): number {
  const { limit, windowMs } = STORE_RATE_LIMITS[name];
  return slidingRetryAfterSeconds(sample, limit, windowMs, rule);
}

/**
 * Chặn khi số hiệu dụng (đã gồm lượt này nếu có đếm) > hạn mức. `Retry-After` tính cho lượt kế tiếp ĐƯỢC ĐẾM (giá trị mới)
 * — mốc muộn nhất trong hai trường hợp, nên khách làm theo không bị chặn lại bất kể gửi giá trị nào.
 */
function decide(name: StoreRateLimit, sample: WindowSample): RateDecision {
  const { limit, windowMs } = STORE_RATE_LIMITS[name];
  return exceedsLimit(sample, limit, windowMs)
    ? { allowed: false, policy: name, retryAfterSeconds: retryAfterSeconds(name, sample, NEXT_HIT) }
    : { allowed: true };
}

/** Đếm một lượt cho `key`. */
export async function consume(
  counter: RateCounter,
  name: StoreRateLimit,
  key: string,
  now: Date,
): Promise<RateDecision> {
  const sample = await counter.hit(bucketOf(name, key), STORE_RATE_LIMITS[name].windowMs, now);
  return decide(name, sample);
}

/** Đếm số giá trị `value` KHÁC NHAU của `key` trong cửa sổ (giá trị đã thấy không tốn lượt). */
export async function consumeDistinct(
  counter: RateCounter,
  name: StoreRateLimit,
  key: string,
  value: string,
  now: Date,
): Promise<RateDecision> {
  const { windowMs } = STORE_RATE_LIMITS[name];
  const seen = await counter.hit(bucketOf(name, `seen\u0000${key}\u0000${value}`), windowMs, now);
  const bucket = bucketOf(name, key);
  // Giá trị mới trong cửa sổ hiện tại → tốn một lượt (đếm rồi so); đã thấy → chỉ đọc, chặn khi hiệu dụng > hạn mức.
  return seen.current === 1
    ? decide(name, await counter.hit(bucket, windowMs, now))
    : decide(name, await counter.peek(bucket, windowMs, now));
}

/** Một bước kiểm; `null` = không áp (thiếu khoá). Chạy tuần tự, dừng ở bước đầu tiên bị chặn. */
type Check = (counter: RateCounter, now: Date) => Promise<RateDecision> | null;

export async function runChecks(counter: RateCounter, checks: Check[], now: Date): Promise<RateDecision> {
  for (const check of checks) {
    const pending = check(counter, now);
    if (!pending) continue;
    const decision = await pending;
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

const counterOf = (req: MedusaRequest): RateCounter => {
  const service = req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
  return {
    hit: (bucket, windowMs, now) => service.hitRateCounter(bucket, windowMs, now),
    peek: (bucket, windowMs, now) => service.peekRateCounter(bucket, windowMs, now),
  };
};

/** Khoá IP cho giới hạn; `null` khi request do chính hạ tầng tin cậy gửi (không có khách đứng sau) hoặc không rõ IP. */
function ipKey(req: MedusaRequest): string | null {
  const { ip, internal } = clientIpOf(req);
  return ip && !internal ? ipRateKey(ip) : null;
}

const bodyOf = (req: MedusaRequest): Record<string, unknown> => {
  const b = req.body;
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

/** Chuỗi khoá ngắn hợp lệ (id giỏ, mã) — giá trị lạ/rỗng → không áp khoá nghiệp vụ (route tự trả 422). */
function shortText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s !== "" && s.length <= max ? s : null;
}

function rateLimitMiddleware(checksOf: (req: MedusaRequest) => Check[]) {
  return async (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
    const now = new Date();
    let decision: RateDecision;
    try {
      decision = await runChecks(counterOf(req), checksOf(req), now);
    } catch (e) {
      // Bộ đếm lỗi (DB) → cho qua: route vẫn có ràng buộc nghiệp vụ dưới khoá; chặn mọi request vì lỗi đếm tệ hơn.
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(`[security] Bộ đếm rate limit lỗi, cho qua: ${(e as Error).message}`);
      return next();
    }
    if (decision.allowed) return next();
    // Log không PII (AT20): chỉ tên chính sách, không IP/giỏ/mã.
    req.scope.resolve(ContainerRegistrationKeys.LOGGER).warn(`[security] rate limited: ${decision.policy}`);
    sendProblem(
      res,
      new CheckoutError("RATE_LIMITED", "Bạn thao tác quá nhiều lần, vui lòng thử lại sau", {
        detail: { retry_after_seconds: decision.retryAfterSeconds },
      }),
    );
  };
}

/** GET /store/x/search. */
export const searchRateLimit = rateLimitMiddleware((req) => {
  const ip = ipKey(req);
  return [(c, now) => (ip ? consume(c, "searchIp", ip, now) : null)];
});

/**
 * GET /store/x/products?q=…: tìm kiếm qua danh sách lọc (T-046). Chỉ áp khi có `q` KHÔNG rỗng theo đúng cách route đọc
 * (`parseFilter`: giá trị đầu, chuẩn hoá, rỗng → không tìm) — duyệt danh mục/lọc không có `q` không tốn lượt. Dùng chung
 * bộ đếm `searchIp` với /store/x/search: cùng một tài nguyên tìm kiếm, đổi endpoint không nhân đôi hạn mức.
 */
export const productSearchRateLimit = rateLimitMiddleware((req) => {
  const ip = ipKey(req);
  const searching = parseFilter(sanitizeQuery(req.query as Record<string, unknown>)).filter.q !== null;
  return [(c, now) => (ip && searching ? consume(c, "searchIp", ip, now) : null)];
});

/** POST /store/x/checkout/quote: mọi báo giá theo IP + mã giảm giá khác nhau theo IP và theo giỏ. */
export const quoteRateLimit = rateLimitMiddleware((req) => {
  const ip = ipKey(req);
  const body = bodyOf(req);
  const cart = shortText(body.cart_id, 64);
  const code = shortText(body.discount_code, 64)?.toUpperCase() ?? null;
  return [
    (c, now) => (ip ? consume(c, "quoteIp", ip, now) : null),
    (c, now) => (ip && code ? consumeDistinct(c, "couponIp", ip, code, now) : null),
    (c, now) => (cart && code ? consumeDistinct(c, "couponCart", cart, code, now) : null),
  ];
});

/** POST /store/x/checkout/submit: lần đặt mới (Idempotency-Key khác nhau) theo IP và theo giỏ. */
export const submitRateLimit = rateLimitMiddleware((req) => {
  const ip = ipKey(req);
  const cart = shortText(bodyOf(req).cart_id, 64);
  // Khoá sai định dạng vẫn tính lượt (route trả 422) — mỗi giá trị lạ là một "lần đặt mới".
  const key = shortText(req.get("Idempotency-Key"), 256) ?? "(none)";
  return [
    (c, now) => (ip ? consumeDistinct(c, "submitIp", ip, key, now) : null),
    (c, now) => (cart ? consumeDistinct(c, "submitCart", cart, key, now) : null),
  ];
});
