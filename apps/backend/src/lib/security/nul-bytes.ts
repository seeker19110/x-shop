import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { sendProblem } from "../http/problem";

/**
 * Chặn ký tự NUL (U+0000) ở biên HTTP (T-085, BASE-SEC-001). Postgres không lưu được NUL trong `text`/`varchar` và
 * từ chối cả câu lệnh chứa nó ("invalid byte sequence for encoding UTF8: 0x00" / "invalid message format") → trước đây
 * mọi route tra DB theo `:id`/`:handle` có `%00` trả 500. Không dữ liệu hợp lệ nào của shop chứa NUL → từ chối sớm 400,
 * một chỗ cho mọi route (đường dẫn, query, thân JSON/text đã parse) thay vì vá từng route.
 */

/** Độ sâu tối đa khi duyệt thân JSON — sâu hơn coi như có vấn đề (thân hợp lệ của shop nông hơn nhiều). */
export const MAX_SCAN_DEPTH = 64;

/** `%00` trong URL thô (đường dẫn hoặc query) — byte NUL thô không hợp lệ trong dòng request HTTP nên chỉ có dạng mã hoá. */
export const ENCODED_NUL = /%00/i;

/** true nếu `value` (chuỗi/khoá/phần tử lồng nhau) chứa U+0000, hoặc lồng sâu quá `MAX_SCAN_DEPTH`. */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (typeof value !== "object" || value === null) return false;
  if (depth >= MAX_SCAN_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => containsNul(v, depth + 1));
  if (Buffer.isBuffer(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (k.includes("\u0000") || containsNul(v, depth + 1)) return true;
  }
  return false;
}

export function rejectNulBytes(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction): void {
  const url = req.originalUrl ?? req.url ?? "";
  if (ENCODED_NUL.test(url) || containsNul(req.body)) {
    sendProblem(res, 400, "INVALID_CHARACTERS", "Dữ liệu chứa ký tự hoặc cấu trúc không hợp lệ");
    return;
  }
  next();
}
