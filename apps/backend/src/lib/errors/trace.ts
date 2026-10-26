import { randomUUID } from "node:crypto";

/**
 * Mã tham chiếu request (`trace_id`) trả trong mọi phản hồi lỗi để tra log (BASE-ERR-003, T-088).
 *
 * Medusa gán `req.requestId` = header `x-request-id` (nếu có) hoặc UUID v4 ở middleware đầu tiên. Header do client gửi là
 * dữ liệu không tin cậy → chỉ nhận khi khớp `REQUEST_ID_PATTERN` (ký tự an toàn cho log/JSON, ≤ 128); khác → sinh UUID mới
 * và ghi đè `req.requestId` để log truy cập của Medusa và phản hồi lỗi dùng cùng một mã.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface WithRequestId {
  requestId?: unknown;
}

export function traceIdOf(req: unknown): string {
  const r = (typeof req === "object" && req !== null ? req : null) as WithRequestId | null;
  const current = r?.requestId;
  if (typeof current === "string" && REQUEST_ID_PATTERN.test(current)) return current;
  const id = randomUUID();
  if (r) r.requestId = id;
  return id;
}
