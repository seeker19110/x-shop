import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { normalizeAdminPath } from "../admin-security/route-match";
import { sendProblem } from "../http/problem";
import { INVALID_PATH, requestPath } from "../http/request-path";
import { mibToBytes } from "@x-shop/domain";

/**
 * Kiểm upload ảnh của Admin (`POST /admin/uploads`, multer của Medusa giữ file trong bộ nhớ) — SEC04, T-14:
 *  - TRƯỚC multer: bắt buộc `multipart/form-data` + `Content-Length` ≤ trần (không có độ dài → 411) — multer không có
 *    giới hạn, không chặn ở đây thì một request lớn đã nằm trọn trong RAM trước khi ai kịp kiểm.
 *  - SAU multer: từng file ≤ trần, loại xác định bằng MAGIC BYTES (không tin `Content-Type`/tên file của client) và chỉ
 *    nhận JPEG/PNG/WebP/AVIF; đuôi tên file phải khớp loại thật (file tĩnh được phục vụ theo đuôi — `x.html` mang đầu PNG
 *    sẽ thành trang HTML); `mimetype` ghi lại bằng loại thật. SVG/HTML/XML/PDF… → 415.
 *  - `POST /admin/uploads/presigned-urls` bị tắt: client tải thẳng lên kho lưu trữ, server không kiểm được nội dung.
 *
 * Chưa làm (ngoài phạm vi, cần thư viện xử lý ảnh): giải mã/tái mã hoá ảnh và xoá metadata EXIF/GPS.
 */
export const UPLOAD_LIMITS = {
  maxFileBytes: mibToBytes(5),
  maxFiles: 10,
  /** Trần cả request (multipart có phần đầu mỗi file). */
  maxRequestBytes: mibToBytes(20),
} as const;

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/avif";

export const IMAGE_EXTENSIONS: Record<ImageType, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/avif": [".avif"],
};

const ascii = (buf: Uint8Array, start: number, end: number) =>
  buf.length >= end ? String.fromCharCode(...buf.subarray(start, end)) : "";

/** Loại ảnh theo chữ ký đầu file; `null` = không phải ảnh được nhận. */
export function sniffImageType(buf: Uint8Array): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return "image/png";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "image/webp";
  if (ascii(buf, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(buf, 8, 12))) return "image/avif";
  return null;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  /** Multer lưu đĩa không đặt `buffer`; đầu vào ép kiểu từ `unknown` nên coi là có thể thiếu. */
  buffer?: Buffer | null;
}

export type FileVerdict =
  | { ok: true; type: ImageType }
  | { ok: false; status: 413 | 415; code: "FILE_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE"; reason: string };

export function checkUploadedFile(file: UploadedFile): FileVerdict {
  const size = file.buffer?.length ?? file.size;
  if (size > UPLOAD_LIMITS.maxFileBytes) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      reason: `tối đa ${UPLOAD_LIMITS.maxFileBytes} byte`,
    };
  }
  const type = file.buffer ? sniffImageType(file.buffer) : null;
  if (!type) {
    return {
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      reason: "chỉ nhận ảnh JPEG/PNG/WebP/AVIF",
    };
  }
  if (!IMAGE_EXTENSIONS[type].includes(extensionOf(file.originalname))) {
    return {
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      reason: `đuôi tên file phải là ${IMAGE_EXTENSIONS[type].join("|")} cho ${type}`,
    };
  }
  return { ok: true, type };
}

/** Middleware toàn cục cho `/admin/uploads*` — chạy TRƯỚC multer của route native. */
export function uploadPrecheck(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (req.method.toUpperCase() !== "POST") return next();
  // Pathname router thấy (T-145: URL tuyệt đối, `%xx` không lách), chuẩn hoá như Express (không phân biệt hoa thường,
  // bỏ `/` cuối) — `/ADMIN/Uploads/` không lách được bước kiểm.
  const decoded = requestPath(req);
  if (decoded === null) return sendProblem(res, INVALID_PATH.status, INVALID_PATH.code, INVALID_PATH.title);
  const path = normalizeAdminPath(decoded);
  if (path === "/admin/uploads/presigned-urls") {
    return sendProblem(
      res,
      403,
      "UPLOAD_METHOD_DISABLED",
      "Tải lên qua URL ký trước bị tắt — dùng POST /admin/uploads",
    );
  }
  if (path !== "/admin/uploads") return next();
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("multipart/form-data")) {
    return sendProblem(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Tải lên phải là multipart/form-data");
  }
  const length = String(req.headers["content-length"] ?? "");
  if (!/^\d{1,12}$/.test(length)) {
    return sendProblem(res, 411, "LENGTH_REQUIRED", "Thiếu Content-Length cho tải lên");
  }
  if (Number(length) > UPLOAD_LIMITS.maxRequestBytes) {
    return sendProblem(res, 413, "PAYLOAD_TOO_LARGE", "Tải lên vượt dung lượng cho phép", [], {
      max_bytes: UPLOAD_LIMITS.maxRequestBytes,
    });
  }
  return next();
}

/** Middleware `POST /admin/uploads` — chạy SAU multer (đọc `req.files`). */
export function uploadContentCheck(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const files = (req as MedusaRequest & { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    return sendProblem(res, 400, "NO_FILES", "Không có file nào trong trường `files`");
  }
  if (files.length > UPLOAD_LIMITS.maxFiles) {
    return sendProblem(res, 413, "TOO_MANY_FILES", "Quá nhiều file trong một lần tải lên", [], {
      max_files: UPLOAD_LIMITS.maxFiles,
    });
  }
  for (const [i, file] of (files as UploadedFile[]).entries()) {
    const verdict = checkUploadedFile(file);
    if (!verdict.ok) {
      return sendProblem(res, verdict.status, verdict.code, "File tải lên không hợp lệ", [
        { param: `files[${i}]`, reason: verdict.reason },
      ]);
    }
    file.mimetype = verdict.type;
  }
  return next();
}
