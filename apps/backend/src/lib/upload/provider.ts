import { realpathSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import type { FileTypes, LocalFileServiceOptions } from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import { LocalFileService } from "@medusajs/medusa/file-local";
import { generateUploadKey, PRIVATE_KEY_PREFIX } from "./key";
import {
  isSameOrInside,
  preparePrivateDir,
  PRIVATE_FILE_MODE,
  privateFileUrl,
  realpathLoose,
} from "./private";

/**
 * File provider local của Medusa, bọc lại để tên lưu do server sinh (BE-FILE-003, T-100) và file private nằm ngoài webroot
 * (BE-FILE-005, T-141).
 *
 * `LocalFileService` gốc ghép tên client vào khoá (`<Date.now()>-<tên gốc>`, `path.parse` giữ cả thư mục con) — tên
 * người dùng nằm trong đường dẫn và URL tĩnh. Ở đây `filename` bị thay bằng `<ULID><đuôi chuẩn theo MIME>` TRƯỚC khi tới
 * provider gốc, nên khoá cuối là `[private-]<Date.now()>-<ULID><đuôi>` — không còn byte nào từ tên client.
 *
 * File private: provider gốc mặc định đặt chúng vào `static/` (Express phục vụ công khai `/static`) và trả URL `/static/…`.
 * Ở đây `private_upload_dir` BẮT BUỘC và phải rời thư mục công khai (khởi tạo thất bại nếu không — fail-closed lúc khởi
 * động); URL trả cho file private (upload, stream, presigned download) là route admin có kiểm quyền
 * `GET /admin/x/files/:key` (lib/upload/private.ts), không phải đường dẫn tĩnh. Đọc/xoá theo khoá giữ hành vi gốc.
 * Thư mục private được tạo lúc khởi tạo với quyền 700 (có sẵn mà mở cho group/other → từ chối), kiểm rời `static/` cả sau
 * khi theo symlink; file private hạ về quyền 600.
 */
/** Cảnh báo một lần khi provider local khởi tạo (dev/test): kho này chỉ đúng cho MỘT tiến trình/máy. */
export const LOCAL_STORAGE_WARNING =
  "File lưu trên đĩa cục bộ (FILE_STORAGE=local) — chỉ đúng cho một tiến trình; nhiều bản sao/worker riêng cần FILE_STORAGE=s3 (docs/ops/ENV.md)";

function warnNotShared(deps: unknown): void {
  let logger: { warn?: (msg: string) => void } | undefined;
  try {
    // Container của Medusa là proxy awilix: thiếu đăng ký thì ném lỗi khi đọc.
    logger = (deps as { logger?: { warn?: (msg: string) => void } } | null)?.logger;
  } catch {
    logger = undefined;
  }
  if (typeof logger?.warn === "function") logger.warn(LOCAL_STORAGE_WARNING);
}

export class ServerKeyedLocalFileService extends LocalFileService {
  static override identifier = "localfs-server-key";

  constructor(deps: unknown, options: LocalFileServiceOptions & { node_env?: string }) {
    // T-154: đĩa cục bộ không dùng chung giữa các bản sao (ảnh upload ở A không có ở B). Production bắt buộc FILE_STORAGE=s3
    // (lib/env đã chặn); đây là lớp thứ hai nếu provider local bị đăng ký bằng cách khác.
    if ((options?.node_env ?? process.env.NODE_ENV) === "production") {
      throw new Error(
        "File provider local: không dùng ở production — file trên đĩa từng máy, bản sao khác không đọc được (FILE_STORAGE=s3)",
      );
    }
    warnNotShared(deps);
    const privateDir =
      typeof options?.private_upload_dir === "string" ? options.private_upload_dir.trim() : "";
    if (privateDir === "") {
      throw new Error(
        "File provider local: thiếu private_upload_dir (PRIVATE_UPLOAD_DIR) — mặc định của Medusa là static/ công khai",
      );
    }
    // Như provider gốc: `upload_dir` vắng hoặc rỗng → `<cwd>/static`.
    const uploadDir = options?.upload_dir;
    const publicDir =
      typeof uploadDir === "string" && uploadDir !== "" ? uploadDir : path.join(process.cwd(), "static");
    // Rời static/ theo chữ và theo symlink, tạo với quyền 700, từ chối thư mục mở cho group/other (lib/upload/private.ts).
    super(deps, { ...options, private_upload_dir: preparePrivateDir(publicDir, privateDir) });
  }

  private isPrivateKey(key: string): boolean {
    return key.startsWith(PRIVATE_KEY_PREFIX);
  }

  /**
   * File private → quyền 600 sau khi ghi (provider gốc ghi theo umask, thường 644). Thư mục 700 đã chặn user khác; đây là
   * lớp thứ hai khi thư mục bị nới quyền về sau. Lỗi chmod → thao tác ghi thất bại (không để file quyền rộng mà báo thành công).
   */
  private async restrict(key: string): Promise<void> {
    if (this.isPrivateKey(key))
      await this.chmodFile(path.join(this.privateUploadDir_, key), PRIVATE_FILE_MODE);
  }

  /** Điểm tiêm cho test (chmod lỗi → thao tác ghi phải thất bại). */
  protected chmodFile(filePath: string, mode: number): Promise<void> {
    return chmod(filePath, mode);
  }

  /** URL công khai giữ nguyên; file private → route admin. */
  private urlFor(result: FileTypes.ProviderFileResultDTO): FileTypes.ProviderFileResultDTO {
    return this.isPrivateKey(result.key)
      ? { ...result, url: privateFileUrl(this.backendUrl_, result.key) }
      : result;
  }

  /**
   * Đường dẫn THẬT (sau khi theo symlink) của file đọc theo khoá phải nằm trong thư mục gốc tương ứng. Provider gốc chỉ kiểm
   * theo chữ (`path.resolve` + `relative`) nên symlink đặt trong thư mục (`private/<khoá>` → `/etc/passwd`) vẫn đọc ra ngoài.
   * Thiếu file → để provider gốc báo (ENOENT/NOT_FOUND); khoá không hợp lệ (NUL, không phải chuỗi) → ném lỗi. Hạn chế: kiểm rồi
   * mở là hai bước (TOCTOU) — thư mục private 700 thuộc user chạy backend nên kẻ ngoài không đặt được symlink; đây là lớp phụ.
   */
  private assertRealInside(fileKey: unknown): void {
    if (typeof fileKey !== "string") {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid file key");
    }
    const baseDir = this.isPrivateKey(fileKey) ? this.privateUploadDir_ : this.uploadDir_;
    let real: string;
    try {
      real = realpathSync(path.resolve(baseDir, fileKey));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw err;
    }
    if (!isSameOrInside(realpathLoose(baseDir), real)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "Invalid file key");
    }
  }

  override async getDownloadStream(file: FileTypes.ProviderGetFileDTO) {
    this.assertRealInside(file?.fileKey);
    return super.getDownloadStream(file);
  }

  override async getAsBuffer(file: FileTypes.ProviderGetFileDTO) {
    this.assertRealInside(file?.fileKey);
    return super.getAsBuffer(file);
  }

  override async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    const res = await super.upload({ ...file, filename: generateUploadKey(file?.mimeType) });
    await this.restrict(res.key);
    return this.urlFor(res);
  }

  override async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO) {
    const res = await super.getUploadStream({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
    if (!this.isPrivateKey(res.fileKey)) return res;
    // Xuất PII có thể ghi lâu: hạ quyền ngay khi file được mở (nỗ lực sớm); bắt buộc lại khi ghi xong.
    res.writeStream.once("open", () => {
      this.restrict(res.fileKey).catch(() => undefined);
    });
    return {
      ...res,
      url: privateFileUrl(this.backendUrl_, res.fileKey),
      promise: res.promise.then(async (done) => {
        await this.restrict(done.key);
        return this.urlFor(done);
      }),
    };
  }

  override async getPresignedDownloadUrl(file: FileTypes.ProviderGetFileDTO): Promise<string> {
    // Gốc kiểm file tồn tại (NOT_FOUND) và khoá không thoát thư mục; chỉ thay URL trả về.
    this.assertRealInside(file?.fileKey);
    const url = await super.getPresignedDownloadUrl(file);
    return this.isPrivateKey(file.fileKey) ? privateFileUrl(this.backendUrl_, file.fileKey) : url;
  }

  override async getPresignedUploadUrl(
    fileData: FileTypes.ProviderGetPresignedUploadUrlDTO,
  ): Promise<FileTypes.ProviderFileResultDTO> {
    return super.getPresignedUploadUrl({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
  }
}
