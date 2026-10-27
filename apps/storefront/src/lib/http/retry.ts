/**
 * Retry phía client cho lỗi TẠM THỜI (FE-STATE-005, docs/ops/CACHE.md §Retry). Quy tắc:
 *  - chỉ retry lỗi mạng và HTTP 408/429/500/502/503/504 (5xx khác không chắc là tạm thời → không retry); mọi 4xx
 *    khác (400/401/403/404/409/422…) là lỗi của yêu cầu, gửi lại y hệt vẫn hỏng → trả ngay;
 *  - chỉ retry yêu cầu an toàn/idempotent: GET/HEAD/OPTIONS, hoặc yêu cầu mang header `Idempotency-Key`, hoặc người gọi
 *    khai `idempotent: true`. POST/PUT/PATCH/DELETE thường KHÔNG retry (tránh tạo đơn/trừ tiền hai lần);
 *  - trần `maxRetries` (mặc định 3 → tối đa 4 lần gọi), backoff luỹ thừa có trần + jitter đầy đủ (không đồng loạt);
 *  - tôn trọng `Retry-After` (giây hoặc ngày HTTP): chờ ít nhất bấy lâu; nếu bắt chờ quá `maxRetryAfterMs` thì dừng,
 *    trả phản hồi lỗi cho người dùng quyết thay vì treo giao diện;
 *  - người dùng huỷ (AbortSignal của người gọi) → dừng ngay, không retry.
 */

import { secondsToMs } from "../units";

export interface RetryOptions {
  /** Số lần thử LẠI tối đa (không tính lần đầu). Mặc định 3. */
  maxRetries?: number;
  /** Gốc backoff (ms). Mặc định 250. */
  baseDelayMs?: number;
  /** Trần một lần chờ do backoff (ms). Mặc định 4000. */
  maxDelayMs?: number;
  /** Chờ theo `Retry-After` quá mức này (ms) thì không retry nữa. Mặc định 10 000. */
  maxRetryAfterMs?: number;
  /** Khai báo yêu cầu idempotent (vd. POST có khóa idempotency ở thân/URL). */
  idempotent?: boolean;
  /** Tiêm để test: ngủ và số ngẫu nhiên [0,1). */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Gọi trước mỗi lần chờ retry (log/đo lường). */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

/** Lỗi `fetch` ném ra: mạng (TypeError) hoặc quá hạn (TimeoutError) là tạm thời; AbortError (người dùng huỷ) thì không. */
export function isTransientError(err: unknown): boolean {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  if (name === "AbortError") return false;
  if (name === "TimeoutError") return true;
  return err instanceof TypeError;
}

/** Yêu cầu có an toàn để gửi lại không? */
export function isRetryableRequest(method: string, headers: Headers, idempotent = false): boolean {
  if (idempotent) return true;
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  return headers.has("idempotency-key");
}

/**
 * `Retry-After` → ms. Số nguyên giây (≥ 0) hoặc ngày HTTP; rỗng/âm/sai → `null` (KHÔNG coi là 0 để khỏi gửi dồn).
 */
export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (v === "") return null;
  if (/^\d+$/.test(v)) {
    const s = Number(v);
    // Số quá lớn (> 2^53) vẫn là "chờ rất lâu", không phải "không có": Infinity vượt trần → dừng, không retry ngay.
    return Number.isSafeInteger(s) ? secondsToMs(s) : Number.POSITIVE_INFINITY;
  }
  // Ngày HTTP luôn có chữ (tên thứ/tháng/GMT); `Date.parse("-3")` hay `"1.5"` lại ra ngày hợp lệ nên phải loại trước.
  if (!/[A-Za-z]/.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Backoff luỹ thừa với jitter đầy đủ: ngẫu nhiên trong [0, min(max, base·2^attempt)]. `attempt` bắt đầu từ 0. */
export function backoffDelayMs(attempt: number, base: number, max: number, random: () => number): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `fetch` có retry cho lỗi tạm thời. Trả `Response` cuối cùng (kể cả lỗi sau khi hết lượt — người gọi tự xử lý như khi
 * không có retry); ném lỗi mạng cuối cùng khi hết lượt. Không bao giờ retry khi `init.signal` đã huỷ.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 250,
    maxDelayMs = 4000,
    maxRetryAfterMs = 10_000,
    idempotent = false,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    onRetry,
  } = options;
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const retryable = isRetryableRequest(method, headers, idempotent);
  const signal = init.signal ?? null;

  for (let attempt = 0; ; attempt++) {
    const last = !retryable || attempt >= maxRetries;
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      if (last || signal?.aborted === true || !isTransientError(err)) throw err;
      const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.({ attempt: attempt + 1, delayMs, reason: err instanceof Error ? err.name : "error" });
      await sleep(delayMs, signal);
      continue;
    }
    if (last || !isTransientStatus(res.status)) return res;
    const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"), now());
    if (retryAfter !== null && retryAfter > maxRetryAfterMs) return res; // bắt chờ quá lâu: để người dùng quyết
    const delayMs = Math.max(retryAfter ?? 0, backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random));
    onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${res.status}` });
    // Giải phóng kết nối của phản hồi lỗi (không chờ: huỷ luồng đã tee có thể không trả về).
    void res.body?.cancel().catch(() => undefined);
    await sleep(delayMs, signal);
    if (signal?.aborted === true) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}
