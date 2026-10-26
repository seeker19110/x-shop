import { AdminApiError, toApiError } from "./problem";

/** Khoá idempotency 32 ký tự [0-9a-f] (hợp lệ 16–128 [A-Za-z0-9_-] của server). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export interface AdminFetchOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined | null>;
  /** Thân JSON. */
  json?: unknown;
  /** Thân CSV thô (`text/csv`). */
  csv?: string;
  idempotencyKey?: string;
}

/** Ghép query, bỏ giá trị rỗng/null/undefined. */
export function buildQuery(query: AdminFetchOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || String(v).trim() === "") continue;
    params.set(k, String(v).trim());
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * Hạn chờ mỗi lời gọi Admin → backend (T-092, BE-REL-001): phủ cả đọc thân. Rộng cho thao tác nặng (nhập CSV, báo cáo)
 * nhưng không vô hạn — quá hạn → mã `TIMEOUT` (kết quả chưa rõ; thao tác ghi có Idempotency-Key nên thử lại an toàn).
 */
export const ADMIN_FETCH_TIMEOUT_MS = 60_000;

/**
 * Gọi API `/admin/x/*` bằng phiên đăng nhập của Admin (cookie). Lỗi → `AdminApiError` (problem+json hoặc thân lạ);
 * mất mạng → mã `NETWORK`; quá `timeoutMs` → `TIMEOUT`. Thân thành công không phải JSON → `{}`.
 */
export async function adminFetch<T>(
  path: string,
  options: AdminFetchOptions = {},
  timeoutMs: number = ADMIN_FETCH_TIMEOUT_MS,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
  let body: string | undefined;
  if (options.csv !== undefined) {
    headers["Content-Type"] = "text/csv; charset=utf-8";
    body = options.csv;
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const signal = AbortSignal.timeout(timeoutMs);
  const isTimeout = (e: unknown) =>
    signal.aborted ||
    (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError");
  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(options.query)}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers,
      body,
      signal,
    });
  } catch (e) {
    if (isTimeout(e)) throw new AdminApiError(0, "TIMEOUT", "Máy chủ không phản hồi kịp");
    throw new AdminApiError(0, "NETWORK", "Không kết nối được máy chủ");
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    // Thân treo giữa chừng → quá hạn; thân không phải JSON → `{}` như trước.
    if (isTimeout(e)) throw new AdminApiError(0, "TIMEOUT", "Máy chủ không phản hồi kịp");
    json = {};
  }
  if (!res.ok) throw toApiError(res.status, json);
  return json as T;
}
