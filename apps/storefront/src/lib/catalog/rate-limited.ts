import { CatalogError } from "./types";

/** Backend không nói thời gian chờ: cửa sổ giới hạn tìm kiếm là 60 giây. */
export const DEFAULT_RETRY_AFTER_S = 60;

/**
 * Backend trả 429 → route công khai trả 429 + `Retry-After` (không cache) thay vì 503, để client không coi là lỗi tạm
 * thời cần thử lại ngay (retry sẽ nhân tải lên backend đang giới hạn). Lỗi khác → `null`.
 */
export function rateLimitedResponse(error: unknown, body: unknown): Response | null {
  if (!(error instanceof CatalogError) || error.status !== 429) return null;
  return Response.json(body, {
    status: 429,
    headers: {
      "Retry-After": String(error.retryAfterS ?? DEFAULT_RETRY_AFTER_S),
      "Cache-Control": "no-store",
    },
  });
}
