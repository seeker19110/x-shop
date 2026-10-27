import path from "node:path";
import type { FileTypes, LocalFileServiceOptions } from "@medusajs/framework/types";
import { LocalFileService } from "@medusajs/medusa/file-local";
import { generateUploadKey, PRIVATE_KEY_PREFIX } from "./key";
import { privateDirProblem, privateFileUrl } from "./private";

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
 */
export class ServerKeyedLocalFileService extends LocalFileService {
  static override identifier = "localfs-server-key";

  constructor(deps: unknown, options: LocalFileServiceOptions) {
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
    const problem = privateDirProblem(publicDir, privateDir);
    if (problem !== null) throw new Error(`File provider local: private_upload_dir ${problem}`);
    super(deps, { ...options, private_upload_dir: path.resolve(privateDir) });
  }

  private isPrivateKey(key: string): boolean {
    return key.startsWith(PRIVATE_KEY_PREFIX);
  }

  /** URL công khai giữ nguyên; file private → route admin. */
  private urlFor(result: FileTypes.ProviderFileResultDTO): FileTypes.ProviderFileResultDTO {
    return this.isPrivateKey(result.key)
      ? { ...result, url: privateFileUrl(this.backendUrl_, result.key) }
      : result;
  }

  override async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    return this.urlFor(await super.upload({ ...file, filename: generateUploadKey(file?.mimeType) }));
  }

  override async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO) {
    const res = await super.getUploadStream({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
    if (!this.isPrivateKey(res.fileKey)) return res;
    return {
      ...res,
      url: privateFileUrl(this.backendUrl_, res.fileKey),
      promise: res.promise.then((done) => this.urlFor(done)),
    };
  }

  override async getPresignedDownloadUrl(file: FileTypes.ProviderGetFileDTO): Promise<string> {
    // Gốc kiểm file tồn tại (NOT_FOUND) và khoá không thoát thư mục; chỉ thay URL trả về.
    const url = await super.getPresignedDownloadUrl(file);
    return this.isPrivateKey(file.fileKey) ? privateFileUrl(this.backendUrl_, file.fileKey) : url;
  }

  override async getPresignedUploadUrl(
    fileData: FileTypes.ProviderGetPresignedUploadUrlDTO,
  ): Promise<FileTypes.ProviderFileResultDTO> {
    return super.getPresignedUploadUrl({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
  }
}
