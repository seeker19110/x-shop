import type { RequestErrorContext, RequestErrorInfo } from "./lib/log/request-error";

/**
 * Hook của Next (instrumentation): lỗi request phía server → log JSON có cấu trúc (BASE-ERR-005, T-190). Nạp lười bên trong
 * hàm (logger dùng stdout; không có process.stdout thì rơi về console) nên bundle client không kéo mã log.
 */
export async function onRequestError(
  error: unknown,
  request: RequestErrorInfo,
  context: RequestErrorContext,
): Promise<void> {
  const { logRequestError } = await import("./lib/log/request-error");
  logRequestError(error, request, context);
}
