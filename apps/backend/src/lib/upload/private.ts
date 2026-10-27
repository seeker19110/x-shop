import path from "node:path";
import type { Permission } from "@x-shop/domain";

/**
 * File private (T-141, BE-FILE-005, hỗ trợ BE-FILE-004).
 *
 * Phân loại trong dự án (rà mọi nơi ghi qua File Module, 2026-10-27):
 *  - CÔNG KHAI: ảnh sản phẩm/nội dung upload qua `POST /admin/uploads` (route native ghi `access: "public"`, chỉ nhận ảnh —
 *    lib/security/upload.ts) → `static/`, phục vụ `/static/<khoá>` như cũ.
 *  - PRIVATE: mọi file workflow của Medusa ghi không khai `access` hoặc `access: "private"` — xuất khách hàng/đơn (PII), xuất
 *    tồn kho/sản phẩm, chunk JSON của nhập sản phẩm. Ảnh đổi trả/chứng từ đối soát hiện KHÔNG đi qua File Module
 *    (`evidence_ref` là chuỗi tham chiếu; CSV đối soát/nhập catalog xử lý trong bộ nhớ, nội dung lưu DB) — khi thêm upload
 *    loại đó phải ghi `access: "private"`.
 *
 * File private nằm trong `private_upload_dir` (env `PRIVATE_UPLOAD_DIR`) — thư mục RỜI hẳn thư mục công khai — và chỉ tải
 * được qua `GET /admin/x/files/:key`: cổng admin (phiên, RBAC, MFA, audit) rồi route stream. Không có URL công khai, không
 * có chữ ký trong URL (không lộ qua log/Referer/lịch sử trình duyệt; thu quyền có hiệu lực ngay).
 */

/** Route tải file private (đường dẫn trên backend). */
export const PRIVATE_FILE_ROUTE = "/admin/x/files";

/** Quyền tải file private: đúng quyền tạo ra chúng (route xuất native mặc định `settings.manage`) — kèm MFA. */
export const PRIVATE_FILE_PERMISSION: Permission = "settings.manage";

/** URL tuyệt đối của file private: cùng origin với URL tĩnh (`backend_url`), đường dẫn là route admin. */
export function privateFileUrl(backendUrl: string, key: string): string {
  return new URL(`${PRIVATE_FILE_ROUTE}/${encodeURIComponent(key)}`, new URL(backendUrl).origin).href;
}

/** `child` trùng hoặc nằm trong `parent` (đã `path.resolve`). */
export function isSameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Hai thư mục phải RỜI nhau: private không trùng, không nằm trong, không chứa thư mục công khai. Trả lý do (không có giá trị
 * đường dẫn) hoặc `null` khi hợp lệ.
 */
export function privateDirProblem(publicDir: string, privateDir: string): string | null {
  const pub = path.resolve(publicDir);
  const priv = path.resolve(privateDir);
  if (isSameOrInside(pub, priv)) return "không được trùng hoặc nằm trong thư mục công khai (static)";
  if (isSameOrInside(priv, pub)) return "không được chứa thư mục công khai (static)";
  return null;
}
