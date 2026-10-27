import type { Readable } from "node:stream";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { requirePermission } from "../../../../../lib/access/require-permission";
import { sendProblem } from "../../../../../lib/http/problem";
import { isPrivateFileKey, mimeForFileKey } from "../../../../../lib/upload/key";
import { PRIVATE_FILE_PERMISSION } from "../../../../../lib/upload/private";

/**
 * GET /admin/x/files/:key — tải file private (T-141, BE-FILE-005): xuất khách hàng/đơn/tồn/sản phẩm, chunk nhập. File nằm
 * trong PRIVATE_UPLOAD_DIR (ngoài `static/`), KHÔNG có URL công khai; link trong thông báo xuất của Medusa trỏ về đây.
 *
 * Thứ tự kiểm: cổng admin (lib/admin-security/guard.ts — phiên, `settings.manage` theo map, MFA, audit từ chối) TRƯỚC khi
 * route chạm tới khoá → không danh tính 401 / thiếu quyền 403 như nhau cho khoá có thật hay không. Trong route: khoá phải
 * khớp đúng mẫu provider sinh (`private-<ms>-<ULID><đuôi>`, một đoạn — không traversal, không đọc file công khai) rồi mới
 * mở; sai mẫu / không có / đã xoá → cùng một 404. Phản hồi: tải về (`attachment`), `private, no-store`, nosniff (header
 * bảo mật chung của /admin).
 */
const notFound = (res: MedusaResponse) => sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy file");

const TEXT_TYPES = new Set(["text/csv", "application/json"]);

const isMissing = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  requirePermission(req, PRIVATE_FILE_PERMISSION);
  const key = (req.params as Record<string, unknown>).key;
  const mime = mimeForFileKey(key);
  if (!isPrivateFileKey(key) || mime === null) return notFound(res);

  let stream: Readable;
  try {
    stream = await req.scope.resolve(Modules.FILE).getDownloadStream(key);
  } catch (err) {
    if (isMissing(err)) return notFound(res);
    throw err;
  }

  res.status(200);
  res.setHeader("Content-Type", TEXT_TYPES.has(mime) ? `${mime}; charset=utf-8` : mime);
  res.setHeader("Content-Disposition", `attachment; filename="${key}"`);
  res.setHeader("Cache-Control", "private, no-store");

  await new Promise<void>((resolve, reject) => {
    stream.once("error", (err: Error) => {
      if (res.headersSent) {
        // Lỗi giữa chừng sau khi đã gửi byte: cắt kết nối (client thấy tải hỏng, không nhận file thiếu như file đủ).
        res.destroy(err);
        return resolve();
      }
      res.removeHeader("Content-Disposition");
      if (isMissing(err)) {
        notFound(res);
        return resolve();
      }
      reject(err); // handler lỗi toàn cục → 500 không lộ đường dẫn
    });
    // Client ngắt → đóng file (pipe không tự huỷ nguồn khi đích đóng).
    res.once("close", () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
};
