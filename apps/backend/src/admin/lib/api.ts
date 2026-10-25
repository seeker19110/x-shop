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
 * Gọi API `/admin/x/*` bằng phiên đăng nhập của Admin (cookie). Lỗi → `AdminApiError` (problem+json hoặc thân lạ);
 * mất mạng → mã `NETWORK`. Thân thành công không phải JSON → `{}`.
 */
export async function adminFetch<T>(path: string, options: AdminFetchOptions = {}): Promise<T> {
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

  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(options.query)}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers,
      body,
    });
  } catch {
    throw new AdminApiError(0, "NETWORK", "Không kết nối được máy chủ");
  }
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw toApiError(res.status, json);
  return json as T;
}
