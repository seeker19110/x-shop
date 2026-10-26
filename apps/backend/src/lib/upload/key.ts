import { generateEntityId, MedusaError } from "@medusajs/framework/utils";
import { IMAGE_EXTENSIONS, type ImageType } from "../security/upload";

/**
 * Tên lưu của file upload do SERVER sinh (BE-FILE-003, T-100): `<ULID><đuôi chuẩn>`.
 *
 *  - Tên gốc của client (`../../etc/passwd`, Unicode, `x.php.jpg`, rỗng…) KHÔNG đi vào khoá/đường dẫn dưới bất kỳ dạng nào
 *    — chỉ loại MIME (đã xác định bằng magic bytes ở `security/upload.ts` với ảnh admin) quyết định đuôi.
 *  - Đuôi lấy từ allowlist MIME → đuôi chuẩn (chữ thường, một đuôi duy nhất). MIME ngoài allowlist → từ chối
 *    (INVALID_DATA) thay vì đoán đuôi — file tĩnh được phục vụ theo đuôi, đuôi lạ có thể thành trang HTML.
 *  - Tên gốc không được lưu ở đâu (Medusa File Module không có bảng metadata; route upload chỉ trả `id`/`url`).
 */

/** MIME được nhận → đuôi chuẩn. Ảnh: theo `IMAGE_EXTENSIONS` (đuôi đầu tiên); CSV/JSON: file export/chunk import của Medusa. */
export const UPLOAD_MIME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    (Object.keys(IMAGE_EXTENSIONS) as ImageType[]).map((type) => [type, IMAGE_EXTENSIONS[type][0]!]),
  ),
  "text/csv": ".csv",
  "application/json": ".json",
});

/** `Image/PNG; charset=x` → `image/png`; không phải chuỗi → "". */
export function normalizeMime(mimeType: unknown): string {
  if (typeof mimeType !== "string") return "";
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** Đuôi chuẩn của MIME trong allowlist; `null` nếu không được nhận. */
export function extensionForMime(mimeType: unknown): string | null {
  const mime = normalizeMime(mimeType);
  return Object.prototype.hasOwnProperty.call(UPLOAD_MIME_EXTENSIONS, mime)
    ? UPLOAD_MIME_EXTENSIONS[mime]!
    : null;
}

/** ULID Crockford base32, 26 ký tự. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Sinh tên lưu `<ULID><đuôi>` cho file có loại `mimeType`. Không nhận tên gốc làm tham số — không thể vô tình dùng.
 * @throws MedusaError INVALID_DATA khi MIME ngoài allowlist (gồm rỗng).
 */
export function generateUploadKey(mimeType: unknown, newId: () => string = () => generateEntityId()): string {
  const ext = extensionForMime(mimeType);
  if (ext === null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Loại file không được nhận khi lưu: chỉ ${Object.keys(UPLOAD_MIME_EXTENSIONS).join("|")}`,
    );
  }
  const id = newId();
  if (!ULID_PATTERN.test(id)) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Bộ sinh id upload trả giá trị không phải ULID",
    );
  }
  return `${id}${ext}`;
}
