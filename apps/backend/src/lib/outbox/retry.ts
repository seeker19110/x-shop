/**
 * Chính sách retry dùng chung (T-093 — ARC-RES-002, BE-JOB-003, BE-REL-003, BE-INT-007). Nguyên tắc (AWS Builders' Library
 * "Timeouts, retries and backoff with jitter"; RFC 9110 §10.2.3 `Retry-After`; RFC 6585 §4 — 429):
 *  - chỉ retry lỗi có thể qua: timeout, kết nối, 5xx, 408, 429 KÈM `Retry-After`; 4xx khác (nghiệp vụ, validate) là lỗi
 *    vĩnh viễn → không retry (outbox: `dead` ngay);
 *  - thao tác không idempotent (POST tạo) chỉ retry khi chắc chắn bên kia CHƯA xử lý (429 kèm `Retry-After`); timeout =
 *    "không biết" → không retry tự động, caller tra lại theo khoá tự nhiên (ARC-INT-011, S-303);
 *  - backoff mũ có trần + jitter (RNG tiêm được để test thống kê không flaky), trần số lần, trần tổng thời gian chờ.
 * Hàm thuần — không đọc đồng hồ/RNG toàn cục khi caller đã tiêm.
 */

/** RNG trả số trong [0, 1). Tiêm vào để test tất định; mặc định `Math.random`. */
export type Random = () => number;

/** `full`: [0, exp) · `equal`: [exp/2, exp) — luôn chờ ít nhất nửa khoảng mũ · `none`: đúng exp. */
export type Jitter = "full" | "equal" | "none";

export interface BackoffPolicy {
  baseDelayMs: number;
  /** Trần một lần chờ (áp TRƯỚC jitter → kết quả không bao giờ vượt trần). */
  maxDelayMs: number;
  jitter: Jitter;
}

/** Ép giá trị RNG về [0, 1): NaN/âm → 0, ≥ 1 → sát dưới 1 (RNG tiêm sai không làm vượt trần). */
function unit(random: Random): number {
  const r = random();
  if (!Number.isFinite(r) || r <= 0) return 0;
  return r >= 1 ? 1 - Number.EPSILON : r;
}

/** Khoảng mũ chưa jitter cho lần hỏng thứ `failedAttempts` (≥ 1; giá trị lạ coi như 1): base·2^(n−1), kẹp trần. */
export function exponentialDelayMs(failedAttempts: number, policy: Omit<BackoffPolicy, "jitter">): number {
  const n = Number.isSafeInteger(failedAttempts) && failedAttempts > 1 ? failedAttempts : 1;
  // 2 ** 1100 = Infinity → Math.min trả trần; không tràn số.
  return Math.min(policy.baseDelayMs * 2 ** (n - 1), policy.maxDelayMs);
}

/** Khoảng chờ (ms, số nguyên ≥ 0, ≤ `maxDelayMs`) trước lần thử kế tiếp sau `failedAttempts` lần hỏng. */
export function backoffDelayMs(
  failedAttempts: number,
  policy: BackoffPolicy,
  random: Random = Math.random,
): number {
  const exp = exponentialDelayMs(failedAttempts, policy);
  if (policy.jitter === "none") return Math.floor(exp);
  const r = unit(random);
  if (policy.jitter === "full") return Math.floor(exp * r);
  return Math.floor(exp / 2 + (exp / 2) * r);
}

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Đọc `Retry-After` (RFC 9110 §10.2.3): `delay-seconds` (chữ số thập phân không dấu) hoặc HTTP-date dạng IMF-fixdate.
 * Kết quả ms, kẹp vào [0, maxMs]; ngày đã qua → 0. Giá trị lạ (âm, số thực, rỗng, định dạng ngày khác, ngày không có
 * thật) → `null` = bỏ qua, caller dùng backoff của mình.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: Date, maxMs: number): number | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^\d{1,16}$/.test(v)) return Math.min(Number(v) * 1000, maxMs);
  if (!IMF_FIXDATE.test(v)) return null;
  const at = Date.parse(v);
  if (!Number.isFinite(at)) return null;
  // Date.parse tự "lăn" ngày không có thật (31 Feb) → đối chiếu lại để bỏ qua.
  if (new Date(at).toUTCString() !== v) return null;
  return Math.min(Math.max(0, at - now.getTime()), maxMs);
}

/** Lỗi vĩnh viễn (validate, 4xx nghiệp vụ) — outbox chuyển `dead` ngay, không retry. `reason` ngắn, không PII. */
export class PermanentError extends Error {
  override readonly name = "PermanentError";
  constructor(
    message: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** HTTP status có nên retry không: 408/429/5xx = tạm thời; 4xx khác = vĩnh viễn; < 400 = không phải lỗi. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status <= 499 && !isTransientStatus(status);
}

export interface RetryInfo {
  /** true = không retry (outbox: dead ngay). */
  permanent: boolean;
  /** Bên kia yêu cầu chờ (đã kẹp) — null = không có. */
  retryAfterMs: number | null;
}

const numberProp = (o: Record<string, unknown>, k: string): number | null => {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/**
 * Phân loại một lỗi bất kỳ ném từ bộ xử lý job/outbox, đi theo chuỗi `cause` (tối đa 5 tầng — adapter bọc lỗi để che PII
 * vẫn giữ được mã gốc): `PermanentError`, `ZodError`, cờ `permanent === true`, hoặc `status`/`statusCode` 4xx không phải
 * 408/429 → vĩnh viễn. `retryAfterMs` (số hữu hạn ≥ 0) ở bất kỳ tầng nào → yêu cầu chờ. Còn lại: tạm thời.
 */
export function retryInfoOf(error: unknown): RetryInfo {
  let permanent = false;
  let retryAfterMs: number | null = null;
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && typeof cur === "object" && cur !== null; depth++) {
    const o = cur as Record<string, unknown>;
    if (cur instanceof PermanentError || o.name === "ZodError" || o.permanent === true) permanent = true;
    const status = numberProp(o, "status") ?? numberProp(o, "statusCode");
    if (status !== null && isPermanentStatus(status)) permanent = true;
    const after = numberProp(o, "retryAfterMs");
    if (retryAfterMs === null && after !== null && after >= 0) retryAfterMs = after;
    cur = o.cause;
  }
  return { permanent, retryAfterMs };
}

/* ---------------------------------------------------------------- retry phía dịch vụ (BE-REL-003) */

export interface RetryPolicy extends BackoffPolicy {
  /** Tổng số lần gọi tối đa (gồm lần đầu). Mặc định dịch vụ: 3 (Google SRE "Handling Overload"). */
  maxAttempts: number;
  /** Trần tổng thời gian (ms, tính từ lần gọi đầu) mà một lần chờ kế tiếp được phép kết thúc trước. */
  totalBudgetMs: number;
}

/**
 * Quyết định của caller cho một lỗi:
 *  - `{ retry: false }` — vĩnh viễn, hoặc tạm thời nhưng không nên thử ngay (429 không kèm `Retry-After`);
 *  - `processed: "no"` — chắc chắn bên kia chưa xử lý (429 kèm `Retry-After`) → retry được cả thao tác không idempotent;
 *  - `processed: "maybe"` — timeout/5xx/lỗi mạng → chỉ retry thao tác idempotent.
 */
export type RetryDecision =
  { retry: false } | { retry: true; processed: "no" | "maybe"; retryAfterMs: number | null };

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Đồng hồ đơn điệu (ms). */
  now?: () => number;
  random?: Random;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Gọi `op` tối đa `maxAttempts` lần. Chờ giữa hai lần = max(backoff có jitter, `Retry-After`); lần chờ làm vượt
 * `totalBudgetMs` → dừng và ném lỗi cuối (không ngủ vô ích). Lỗi ném ra luôn là lỗi gốc của lần thử cuối — caller (vd
 * outbox) vẫn đọc được `retryAfterMs` trên đó để hẹn lần sau.
 */
export async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
  opts: {
    policy: RetryPolicy;
    idempotent: boolean;
    classify: (error: unknown) => RetryDecision;
  } & RetryDeps,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => performance.now());
  const random = opts.random ?? Math.random;
  const max = Math.max(1, Math.floor(opts.policy.maxAttempts));
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await op(attempt);
    } catch (e) {
      if (attempt >= max) throw e;
      const d = opts.classify(e);
      if (!d.retry) throw e;
      if (!opts.idempotent && d.processed !== "no") throw e;
      const delay = Math.max(backoffDelayMs(attempt, opts.policy, random), d.retryAfterMs ?? 0);
      if (now() - started + delay > opts.policy.totalBudgetMs) throw e;
      await sleep(delay);
    }
  }
}
