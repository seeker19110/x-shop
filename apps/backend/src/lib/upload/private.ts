import { accessSync, constants as fsConstants, mkdirSync, realpathSync, statSync } from "node:fs";
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
 * File private nằm ở kho private: bucket `S3_PRIVATE_BUCKET` (FILE_STORAGE=s3 — production, T-154, lib/upload/s3) hoặc
 * `private_upload_dir` (env `PRIVATE_UPLOAD_DIR`, FILE_STORAGE=local — dev/test) — RỜI hẳn kho công khai — và chỉ tải
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
 * đường dẫn) hoặc `null` khi hợp lệ. Kiểm theo chữ — dùng ở env (chưa chạm đĩa); lúc khởi động provider kiểm lại sau khi
 * theo symlink (`preparePrivateDir`).
 */
export function privateDirProblem(publicDir: string, privateDir: string): string | null {
  const pub = path.resolve(publicDir);
  const priv = path.resolve(privateDir);
  if (isSameOrInside(pub, priv)) return "không được trùng hoặc nằm trong thư mục công khai (static)";
  if (isSameOrInside(priv, pub)) return "không được chứa thư mục công khai (static)";
  return null;
}

/** Quyền thư mục private: chỉ user chạy backend. */
export const PRIVATE_DIR_MODE = 0o700;
/** Quyền file private. */
export const PRIVATE_FILE_MODE = 0o600;

/** `realpath` của tổ tiên gần nhất đang tồn tại + phần còn lại (thư mục công khai có thể chưa được tạo). */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...rest);
    } catch (err) {
      const parent = path.dirname(head);
      if ((err as { code?: unknown }).code !== "ENOENT" || parent === head) throw err;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Chuẩn bị thư mục private lúc khởi động provider (fail-closed — lỗi là backend không khởi động):
 *  1. rời thư mục công khai theo chữ (trước khi tạo gì trên đĩa);
 *  2. tạo nếu chưa có với quyền 700;
 *  3. rời thư mục công khai SAU KHI theo symlink (`realpath`) — symlink từ PRIVATE_UPLOAD_DIR vào `static/` bị từ chối;
 *  4. thư mục có sẵn mà mở cho group/other (bit 077) → từ chối, không tự `chmod` thư mục do người vận hành tạo;
 *  5. thư mục phải THUỘC user đang chạy (euid) và user đó đọc/ghi/duyệt được (D-104) — thư mục 700 của user khác (điểm mount
 *     root, `fsGroup`…) bị từ chối lúc khởi động thay vì lỗi ở lần xuất đầu tiên.
 * Trả đường dẫn thật để provider ghi/đọc đúng nơi đã kiểm (ghim — đổi symlink về sau không đổi nơi ghi). Thông báo lỗi
 * không chứa đường dẫn.
 */
export interface PrivateDirSystem {
  /** `undefined` khi nền tảng không có khái niệm euid (Windows) → bỏ qua kiểm chủ sở hữu. */
  geteuid: (() => number) | undefined;
  stat: (p: string) => { isDirectory(): boolean; mode: number; uid: number };
  /** Ném lỗi khi thiếu quyền (như `fs.accessSync`). */
  access: (p: string, mode: number) => void;
  platform: NodeJS.Platform;
}

const NODE_SYSTEM: PrivateDirSystem = {
  geteuid: process.geteuid?.bind(process),
  stat: (p) => statSync(p),
  access: (p, mode) => accessSync(p, mode),
  platform: process.platform,
};

export function preparePrivateDir(
  publicDir: string,
  privateDir: string,
  system: PrivateDirSystem = NODE_SYSTEM,
): string {
  const lexical = privateDirProblem(publicDir, privateDir);
  if (lexical !== null) throw new Error(`File provider local: private_upload_dir ${lexical}`);
  mkdirSync(privateDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const real = realpathSync(privateDir);
  const st = system.stat(real);
  if (!st.isDirectory()) throw new Error("File provider local: private_upload_dir không phải thư mục");
  const resolved = privateDirProblem(realpathLoose(publicDir), real);
  if (resolved !== null) {
    throw new Error(`File provider local: private_upload_dir (sau khi theo symlink) ${resolved}`);
  }
  if (system.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(
      `File provider local: private_upload_dir mở quyền cho group/other (${(st.mode & 0o777).toString(8)}) — chmod 700`,
    );
  }
  if (system.geteuid !== undefined) {
    const euid = system.geteuid();
    if (st.uid !== euid) {
      throw new Error(
        `File provider local: private_upload_dir thuộc uid ${st.uid}, không phải user chạy backend (uid ${euid}) — chown`,
      );
    }
  }
  try {
    system.access(real, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new Error("File provider local: private_upload_dir không đọc/ghi/duyệt được bởi user chạy backend");
  }
  return real;
}
