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

/** Nhóm đuôi trong allowlist dạng regex (`\.jpg|\.png|…`). */
const EXTENSION_ALTERNATION = Object.values(UPLOAD_MIME_EXTENSIONS)
  .map((ext) => ext.replace(".", "\\."))
  .join("|");

/**
 * Tiền tố khoá file private: provider local Medusa (`delete`/`getAsBuffer`… chọn thư mục theo tiền tố này) và provider S3
 * của dự án (chọn bucket private theo tiền tố này — T-154).
 */
export const PRIVATE_KEY_PREFIX = "private-";

/**
 * Khoá file private ĐÚNG như provider này sinh (T-141): `private-<Date.now() 13 chữ số>-<ULID><đuôi trong allowlist>`.
 * Một đoạn duy nhất — không `/`, `\`, `..`, ký tự điều khiển, chữ thường/hoa lẫn lộn — nên không thể trỏ ra ngoài thư mục
 * private; 80 bit ngẫu nhiên của ULID làm khoá không đoán được. Mọi chuỗi khác (kể cả khoá file công khai) → không hợp lệ.
 */
export const PRIVATE_FILE_KEY_PATTERN = new RegExp(
  `^${PRIVATE_KEY_PREFIX}\\d{13}-[0-9A-HJKMNP-TV-Z]{26}(?:${EXTENSION_ALTERNATION})$`,
);

export function isPrivateFileKey(key: unknown): key is string {
  return typeof key === "string" && PRIVATE_FILE_KEY_PATTERN.test(key);
}

/** MIME theo đuôi chuẩn của khoá (nghịch đảo allowlist); đuôi lạ → `null`. */
export function mimeForFileKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const dot = key.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = key.slice(dot);
  const hit = Object.entries(UPLOAD_MIME_EXTENSIONS).find(([, e]) => e === ext);
  return hit ? hit[0] : null;
}

/**
 * Khoá file CÔNG KHAI do provider sinh (T-100, T-154): `<Date.now() 13 chữ số>-<ULID><đuôi trong allowlist>` — cùng dạng
 * cho provider local (`static/`) và S3 (bucket công khai). Không bao giờ bắt đầu bằng `private-`.
 */
export const PUBLIC_FILE_KEY_PATTERN = new RegExp(
  `^\\d{13}-[0-9A-HJKMNP-TV-Z]{26}(?:${EXTENSION_ALTERNATION})$`,
);

export function isPublicFileKey(key: unknown): key is string {
  return typeof key === "string" && PUBLIC_FILE_KEY_PATTERN.test(key);
}

/**
 * Đuôi chuẩn của MIME trong allowlist, hoặc ném lỗi — dùng ở MỌI provider trước khi ghi.
 * @throws MedusaError INVALID_DATA khi MIME ngoài allowlist (gồm rỗng).
 */
export function requireUploadExtension(mimeType: unknown): string {
  const ext = extensionForMime(mimeType);
  if (ext === null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Loại file không được nhận khi lưu: chỉ ${Object.keys(UPLOAD_MIME_EXTENSIONS).join("|")}`,
    );
  }
  return ext;
}

/**
 * Sinh tên lưu `<ULID><đuôi>` cho file có loại `mimeType`. Không nhận tên gốc làm tham số — không thể vô tình dùng.
 * @throws MedusaError INVALID_DATA khi MIME ngoài allowlist (gồm rỗng).
 */
export function generateUploadKey(mimeType: unknown, newId: () => string = () => generateEntityId()): string {
  const ext = requireUploadExtension(mimeType);
  const id = newId();
  if (!ULID_PATTERN.test(id)) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Bộ sinh id upload trả giá trị không phải ULID",
    );
  }
  return `${id}${ext}`;
}
