import type { Readable } from "node:stream";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { S3FileService } from "@medusajs/file-s3/dist/services/s3-file";
import type { FileTypes, Logger, S3FileServiceOptions } from "@medusajs/framework/types";
import { AbstractFileProviderService, MedusaError } from "@medusajs/framework/utils";
import { isPrivateFileKey, isPublicFileKey, PRIVATE_KEY_PREFIX, requireUploadExtension } from "../key";
import { privateFileUrl } from "../private";

/**
 * File provider dùng chung giữa các bản sao (T-154, ARC-RES-005, BE-FILE-004): lưu trên kho S3-compatible thay vì đĩa
 * cục bộ của từng máy — ảnh upload ở bản sao A đọc được ở bản sao B, file xuất do worker ghi tải được qua server.
 *
 * Hai bucket RỜI nhau:
 *  - `bucket` (công khai): ảnh `POST /admin/uploads` (`access: "public"`). Đọc nặc danh qua `file_url` do POLICY của
 *    bucket cho phép (không dùng ACL theo object: AWS mặc định chặn ACL, kho tự host thường bỏ qua) — `acl: false`.
 *  - `private_bucket`: mọi file không khai `access: "public"` (xuất PII, chunk nhập — T-141). Bucket này KHÔNG được có
 *    policy đọc nặc danh; file chỉ tải qua `GET /admin/x/files/:key` (phiên + RBAC + MFA). URL trả ra luôn là route đó —
 *    không URL ký, không URL bucket (D-102). Ngữ nghĩa PRIVATE_UPLOAD_DIR của T-141 giữ nguyên, chỉ đổi nơi chứa.
 *
 * Khoá giữ đúng dạng của provider local (T-100/T-141), không byte nào từ tên client:
 *  công khai `<Date.now()>-<ULID><đuôi>` · private `private-<Date.now()>-<ULID><đuôi>`.
 * Provider S3 của Medusa sinh khoá `<tên>-<ulid><đuôi>`; ở đây `tên` là `[private-]<Date.now()>` do server đặt, rồi khoá
 * nhận về được KIỂM LẠI theo mẫu (Medusa đổi cách đặt khoá khi nâng cấp → ghi thất bại, không lưu khoá lạ).
 *
 * Khác provider gốc: `delete` không nuốt lỗi (file PII phải xoá thật hoặc báo lỗi); thiếu file → lỗi `code: "ENOENT"` như
 * provider local (route tải trả 404); không cấp URL ký để client tự PUT (`getPresignedUploadUrl` — server không kiểm được
 * nội dung, route `/admin/uploads/presigned-urls` cũng đã tắt ở lib/security/upload.ts).
 */

export interface SharedS3Options {
  /** Endpoint S3-compatible (tự host); vắng = AWS S3 theo `region`. */
  endpoint?: string;
  region: string;
  /** Bucket công khai (ảnh). */
  bucket: string;
  /** Bucket private (xuất PII, chunk nhập) — phải khác `bucket`. */
  private_bucket: string;
  /** Gốc URL công khai của `bucket` (CDN/web endpoint), không `/` cuối. */
  file_url: string;
  access_key_id: string;
  secret_access_key: string;
  /** Path-style (`<endpoint>/<bucket>/<khoá>`) — kho tự host thường cần. */
  force_path_style: boolean;
  /** Gốc backend để dựng URL route tải file private. */
  backend_url: string;
}

/** Cache của object private: không cho proxy/trình duyệt giữ bản sao. */
export const PRIVATE_CACHE_CONTROL = "private, no-store";

const S3_NOT_FOUND = new Set(["NoSuchKey", "NotFound"]);

/** Lỗi S3 "không có khoá" (không gồm NoSuchBucket — sai cấu hình phải nổi lên). */
export function isS3NotFound(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && S3_NOT_FOUND.has(name);
}

/** Thiếu file: cùng `code` với provider local (`ENOENT`) để route tải trả 404 như nhau; không chứa khoá. */
export function fileNotFound(): MedusaError {
  return new MedusaError(MedusaError.Types.NOT_FOUND, "Không tìm thấy file", "ENOENT");
}

/** Một bucket: provider S3 gốc của Medusa + xoá không nuốt lỗi, thiếu file → ENOENT, kiểm tồn tại. */
export class BucketStore extends S3FileService {
  readonly bucketName: string;

  constructor(deps: { logger: Logger }, options: S3FileServiceOptions) {
    super(deps, options);
    this.bucketName = options.bucket;
  }

  /** Gốc URL công khai (`file_url`) của bucket. */
  get fileUrl(): string {
    return this.config_.fileUrl;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client_.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  /** Xoá từng khoá; lỗi (mạng, quyền) ném ra. Khoá không tồn tại: S3 trả thành công (idempotent). */
  async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await this.client_.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
    }
  }

  override async getDownloadStream(file: FileTypes.ProviderGetFileDTO): Promise<Readable> {
    try {
      return await super.getDownloadStream(file);
    } catch (err) {
      if (isS3NotFound(err)) throw fileNotFound();
      throw err;
    }
  }

  override async getAsBuffer(file: FileTypes.ProviderGetFileDTO): Promise<Buffer> {
    try {
      return await super.getAsBuffer(file);
    } catch (err) {
      if (isS3NotFound(err)) throw fileNotFound();
      throw err;
    }
  }
}

/** Kho của một khoá: `private-…` → bucket private (chỉ khoá đúng mẫu); còn lại → bucket công khai (chỉ khoá đúng mẫu). */
type Target = { store: BucketStore; isPrivate: boolean };

export class SharedS3FileService extends AbstractFileProviderService {
  static override identifier = "s3-shared";

  protected readonly public_: BucketStore;
  protected readonly private_: BucketStore;
  protected readonly backendUrl_: string;

  constructor(deps: { logger: Logger }, options: SharedS3Options) {
    super();
    const required = [
      "region",
      "bucket",
      "private_bucket",
      "file_url",
      "access_key_id",
      "secret_access_key",
      "backend_url",
    ] as const;
    for (const key of required) {
      if (typeof options?.[key] !== "string" || options[key].trim() === "") {
        throw new Error(`File provider S3: thiếu tuỳ chọn ${key}`);
      }
    }
    if (options.bucket === options.private_bucket) {
      throw new Error("File provider S3: bucket private phải khác bucket công khai");
    }
    const common = {
      endpoint: options.endpoint,
      region: options.region,
      access_key_id: options.access_key_id,
      secret_access_key: options.secret_access_key,
      authentication_method: "access-key" as const,
      // Không gửi ACL theo object: quyền đọc do policy của bucket quyết (AWS mặc định BucketOwnerEnforced từ chối ACL).
      acl: false as const,
      additional_client_config: {
        forcePathStyle: options.force_path_style,
        // Kho S3-compatible tự host không phải bản nào cũng nhận checksum mặc định (CRC32) của SDK v3 mới — chỉ gửi khi
        // thao tác bắt buộc (DeleteObjects…).
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      },
    };
    this.public_ = new BucketStore(deps, { ...common, bucket: options.bucket, file_url: options.file_url });
    this.private_ = new BucketStore(deps, {
      ...common,
      bucket: options.private_bucket,
      // URL bucket private không bao giờ được trả ra (luôn thay bằng route admin); giá trị này chỉ để thoả kiểu.
      file_url: options.backend_url,
      cache_control: PRIVATE_CACHE_CONTROL,
    });
    this.backendUrl_ = options.backend_url;
  }

  /** Khoá do provider sinh → kho; khoá lạ (traversal, `/`, tên client, sai đuôi…) → `null`. */
  protected targetOf(key: unknown): Target | null {
    if (isPrivateFileKey(key)) return { store: this.private_, isPrivate: true };
    if (isPublicFileKey(key)) return { store: this.public_, isPrivate: false };
    return null;
  }

  protected requireTarget(key: unknown): Target {
    const target = this.targetOf(key);
    if (target === null) throw fileNotFound();
    return target;
  }

  /** Tên đưa cho provider gốc: `[private-]<Date.now()><đuôi>` — gốc chèn `-<ulid>` trước đuôi. */
  protected nameFor(mimeType: unknown, isPrivate: boolean): string {
    const ext = requireUploadExtension(mimeType);
    return `${isPrivate ? PRIVATE_KEY_PREFIX : ""}${Date.now()}${ext}`;
  }

  /** Khoá nhận về phải đúng mẫu của loại file đã ghi; sai → xoá (nỗ lực) và báo lỗi. */
  protected async assertKey(key: string, isPrivate: boolean, store: BucketStore): Promise<void> {
    const ok = isPrivate ? isPrivateFileKey(key) : isPublicFileKey(key);
    if (ok) return;
    await store.deleteKeys([key]).catch(() => undefined);
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "File provider S3: khoá sinh ra không đúng mẫu (provider gốc đổi cách đặt khoá?)",
    );
  }

  protected urlFor(key: string, isPrivate: boolean, publicUrl: string): string {
    return isPrivate ? privateFileUrl(this.backendUrl_, key) : publicUrl;
  }

  override async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
    const isPrivate = file?.access !== "public";
    const store = isPrivate ? this.private_ : this.public_;
    const res = await store.upload({ ...file, filename: this.nameFor(file?.mimeType, isPrivate) });
    await this.assertKey(res.key, isPrivate, store);
    return { key: res.key, url: this.urlFor(res.key, isPrivate, res.url) };
  }

  override async getUploadStream(fileData: FileTypes.ProviderUploadStreamDTO) {
    const isPrivate = fileData?.access !== "public";
    const store = isPrivate ? this.private_ : this.public_;
    const res = await store.getUploadStream({
      ...fileData,
      filename: this.nameFor(fileData?.mimeType, isPrivate),
    });
    if (!(isPrivate ? isPrivateFileKey(res.fileKey) : isPublicFileKey(res.fileKey))) {
      // Chưa có byte nào được ghi: huỷ luồng, bỏ lời hứa upload (không để rejection treo).
      res.promise.catch(() => undefined);
      res.writeStream.destroy();
      await this.assertKey(res.fileKey, isPrivate, store);
    }
    return {
      writeStream: res.writeStream,
      fileKey: res.fileKey,
      url: this.urlFor(res.fileKey, isPrivate, res.url),
      promise: res.promise.then((done) => ({
        key: done.key,
        url: this.urlFor(done.key, isPrivate, done.url),
      })),
    };
  }

  override async delete(
    files: FileTypes.ProviderDeleteFileDTO | FileTypes.ProviderDeleteFileDTO[],
  ): Promise<void> {
    const list = Array.isArray(files) ? files : [files];
    const byStore = new Map<BucketStore, string[]>();
    for (const file of list) {
      // Khoá lạ không thể do provider này ghi → không có gì để xoá (như provider local với file không tồn tại).
      const target = this.targetOf(file?.fileKey);
      if (target === null) continue;
      byStore.set(target.store, [...(byStore.get(target.store) ?? []), file.fileKey]);
    }
    for (const [store, keys] of byStore) await store.deleteKeys(keys);
  }

  override async getPresignedDownloadUrl(file: FileTypes.ProviderGetFileDTO): Promise<string> {
    const { store, isPrivate } = this.requireTarget(file?.fileKey);
    if (!(await store.exists(file.fileKey))) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Không tìm thấy file");
    }
    // Ảnh công khai: URL công khai ổn định (không ký, không hết hạn); private: route admin có kiểm quyền.
    const publicUrl = `${this.public_.fileUrl}/${encodeURIComponent(file.fileKey)}`;
    return this.urlFor(file.fileKey, isPrivate, publicUrl);
  }

  async getPresignedUploadUrl(): Promise<FileTypes.ProviderFileResultDTO> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Không cấp URL tải thẳng lên kho lưu trữ: upload phải qua server để kiểm nội dung",
    );
  }

  override async getDownloadStream(file: FileTypes.ProviderGetFileDTO): Promise<Readable> {
    return this.requireTarget(file?.fileKey).store.getDownloadStream(file);
  }

  override async getAsBuffer(file: FileTypes.ProviderGetFileDTO): Promise<Buffer> {
    return this.requireTarget(file?.fileKey).store.getAsBuffer(file);
  }
}
