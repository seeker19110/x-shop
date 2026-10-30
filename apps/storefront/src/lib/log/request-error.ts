import { REDACTED, redactText } from "./redact";
import { getLogger, type HeaderBag, type Logger } from "./logger";

/** Phần dùng được của tham số `request`/`context` mà Next truyền cho `onRequestError` (instrumentation). */
export interface RequestErrorInfo {
  path: string;
  method: string;
  headers: HeaderBag;
}
export interface RequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  revalidateReason?: string | null;
}

/** Bỏ query/fragment: query có thể mang mã đơn, email, token (không bao giờ ghi vào log). */
export function pathOnly(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/** Đường dẫn an toàn để log: giải mã %XX (thử) rồi che — `%40` không được giấu email khỏi bộ che; có PII → `[REDACTED]`. */
export function safePath(path: string): string {
  const p = pathOnly(path);
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // %XX sai: quét bản thô
  }
  return redactText(decoded) === REDACTED || redactText(p) === REDACTED ? REDACTED : p;
}

/**
 * Ghi lỗi request-level của Next (render, route handler, server action, proxy) thành một dòng log `error` có `trace_id`
 * theo header của request. `digest` của Next dùng để đối chiếu với trang lỗi phía client. Không ném.
 */
export function logRequestError(
  error: unknown,
  request: RequestErrorInfo,
  context: RequestErrorContext = {},
  logger: Logger = getLogger(),
): void {
  try {
    const digest = (error as { digest?: unknown } | null)?.digest;
    // Chỉ để rút trace_id (x-request-id/traceparent); header không bao giờ được ghi vào log.
    const { headers } = request;
    logger.forRequest(headers).error("Lỗi xử lý request", error, {
      "http.request.method": request.method,
      "url.path": safePath(String(request.path)),
      ...(context.routerKind !== undefined && { "next.router_kind": context.routerKind }),
      ...(context.routePath !== undefined && { "next.route_path": context.routePath }),
      ...(context.routeType !== undefined && { "next.route_type": context.routeType }),
      ...(context.renderSource !== undefined && { "next.render_source": context.renderSource }),
      ...(typeof digest === "string" && { "error.digest": digest }),
    });
  } catch {
    // không bao giờ làm hỏng phản hồi
  }
}
