import type { FileTypes } from "@medusajs/framework/types";
import { LocalFileService } from "@medusajs/medusa/file-local";
import { generateUploadKey } from "./key";

/**
 * File provider local của Medusa, bọc lại để tên lưu do server sinh (BE-FILE-003, T-100).
 *
 * `LocalFileService` gốc ghép tên client vào khoá (`<Date.now()>-<tên gốc>`, `path.parse` giữ cả thư mục con) — tên
 * người dùng nằm trong đường dẫn và URL tĩnh. Ở đây `filename` bị thay bằng `<ULID><đuôi chuẩn theo MIME>` TRƯỚC khi tới
 * provider gốc, nên khoá cuối là `[private-]<Date.now()>-<ULID><đuôi>` — không còn byte nào từ tên client. Các thao tác
 * đọc/xoá theo khoá giữ nguyên hành vi gốc (khoá do chính provider này trả về).
 */
export class ServerKeyedLocalFileService extends LocalFileService {
  static override identifier = "localfs-server-key";

  override async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    return super.upload({ ...file, filename: generateUploadKey(file?.mimeType) });
  }

  override async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO) {
    return super.getUploadStream({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
  }

  override async getPresignedUploadUrl(
    fileData: FileTypes.ProviderGetPresignedUploadUrlDTO,
  ): Promise<FileTypes.ProviderFileResultDTO> {
    return super.getPresignedUploadUrl({ ...fileData, filename: generateUploadKey(fileData?.mimeType) });
  }
}
