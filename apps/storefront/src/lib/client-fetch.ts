/**
 * `clientFetch` — cửa DUY NHẤT cho I/O mạng trong component (FE-STATE-001/005, XC-PERF-006). Mọi lời gọi `fetch` trực
 * tiếp trong `src/components` bị ESLint chặn; lớp này đặt trên `fetchWithRetry` (lib/http/retry — không nhân bản logic):
 *  - HẠN mỗi lần gọi `CLIENT_FETCH_TIMEOUT_MS` = 6000 ms (mạng di động chậm vẫn kịp; treo thì báo lỗi, không quay mãi);
 *  - retry CHỈ lỗi tạm thời (mạng, timeout, 408/429/500/502/503/504) và CHỈ GET/HEAD/OPTIONS (hoặc có `Idempotency-Key`);
 *    mặc định 2 lần thử lại → tối đa 3 lần gọi, xấu nhất ≈ 3 × 6 s + backoff (jitter đầy đủ, trần 2 s) — người gọi nhạy
 *    độ trễ (gợi ý/đếm) hạ `maxRetries`/`timeoutMs`;
 *  - `Retry-After` được tôn trọng nhưng trần `CLIENT_FETCH_MAX_RETRY_AFTER_MS` = 5000 ms: đòi chờ lâu hơn → trả phản hồi
 *    lỗi ngay thay vì treo giao diện;
 *  - `init.signal` (huỷ khi component unmount/đổi đầu vào): abort → dừng ngay, không retry, ném `ClientFetchError("ABORTED")`.
 * Phản hồi HTTP lỗi (4xx/5xx sau khi hết lượt) được TRẢ như `fetch` thường; chỉ lỗi truyền tải/timeout/huỷ mới ném.
 */

import { fetchWithRetry, type RetryOptions } from "./http/retry";

export const CLIENT_FETCH_TIMEOUT_MS = 6000;
export const CLIENT_FETCH_MAX_RETRIES = 2;
export const CLIENT_FETCH_MAX_RETRY_AFTER_MS = 5000;
/** Hạn cho tương tác gõ-là-thấy (gợi ý, đếm kết quả): kết quả trễ hơn thế không còn giá trị. */
export const CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS = 4000;
const CLIENT_FETCH_MAX_DELAY_MS = 2000;

export type ClientFetchErrorCode = "TIMEOUT" | "ABORTED" | "NETWORK";

export class ClientFetchError extends Error {
  readonly code: ClientFetchErrorCode;
  constructor(code: ClientFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientFetchError";
    this.code = code;
  }
}

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : "";
}

function classify(err: unknown, signal: AbortSignal | null | undefined, timeoutMs: number): ClientFetchError {
  if (signal?.aborted === true) return new ClientFetchError("ABORTED", "Yêu cầu đã bị huỷ.", { cause: err });
  if (errorName(err) === "TimeoutError") {
    return new ClientFetchError("TIMEOUT", `Máy chủ không phản hồi trong ${timeoutMs} ms.`, { cause: err });
  }
  if (errorName(err) === "AbortError")
    return new ClientFetchError("ABORTED", "Yêu cầu đã bị huỷ.", { cause: err });
  return new ClientFetchError("NETWORK", "Không kết nối được máy chủ.", { cause: err });
}

const BODY_READERS = new Set(["json", "text", "arrayBuffer", "blob", "formData", "bytes"]);

/**
 * Hết hạn/huỷ KHI ĐANG ĐỌC THÂN (`r.json()`…) cũng phải ra `ClientFetchError` như lúc chờ header: bọc các hàm đọc thân
 * (và `clone()`) để lỗi từ luồng bị huỷ được phân loại cùng một cách. Phản hồi vẫn dùng như `Response` thường.
 */
function wrapBodyErrors(res: Response, signal: AbortSignal | null | undefined, timeoutMs: number): Response {
  return new Proxy(res, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "clone") return () => wrapBodyErrors(target.clone(), signal, timeoutMs);
      if (typeof prop === "string" && BODY_READERS.has(prop)) {
        return async (...args: unknown[]) => {
          try {
            return await fn.apply(target, args);
          } catch (err) {
            // Chỉ hết hạn/huỷ mới đổi kiểu; lỗi khác (vd. JSON hỏng → SyntaxError) giữ nguyên cho người gọi.
            const name = errorName(err);
            if (signal?.aborted === true || name === "TimeoutError" || name === "AbortError") {
              throw classify(err, signal, timeoutMs);
            }
            throw err;
          }
        };
      }
      return fn.bind(target);
    },
  });
}

export async function clientFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? CLIENT_FETCH_TIMEOUT_MS;
  try {
    const res = await fetchWithRetry(input, init, {
      maxRetries: CLIENT_FETCH_MAX_RETRIES,
      maxDelayMs: CLIENT_FETCH_MAX_DELAY_MS,
      maxRetryAfterMs: CLIENT_FETCH_MAX_RETRY_AFTER_MS,
      ...options,
      timeoutMs,
    });
    return wrapBodyErrors(res, init.signal, timeoutMs);
  } catch (err) {
    if (err instanceof RangeError) throw err; // lỗi cấu hình của người gọi, không phải I/O
    throw classify(err, init.signal, timeoutMs);
  }
}
