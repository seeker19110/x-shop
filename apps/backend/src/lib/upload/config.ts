import type { SharedS3Options } from "./s3/provider";

/**
 * Provider của File Module theo kho đã chọn (T-154) — `medusa-config.ts` gọi với env đã kiểm (lib/env). Kiểu đầu vào khai
 * cấu trúc (không import lib/env: lib/env đã import lib/upload/private).
 *
 *  - `local`: đĩa của máy đang chạy — `static/` (công khai) + PRIVATE_UPLOAD_DIR (T-141). CHỈ dev/test một tiến trình.
 *  - `s3`: kho S3-compatible dùng chung giữa các bản sao — bucket công khai + bucket private (lib/upload/s3).
 */
export interface FileStorageInput {
  privateUploadDir: string;
  /** Gốc backend (MEDUSA_BACKEND_URL); vắng → mặc định dev của Medusa. */
  backendUrl: string | undefined;
  fileStorage:
    | { kind: "local" }
    | {
        kind: "s3";
        endpoint: string | undefined;
        region: string;
        bucket: string;
        privateBucket: string;
        fileUrl: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      };
}

/** Gốc backend mặc định khi chạy dev (Medusa `localhost:9000`). Production + s3 bắt buộc MEDUSA_BACKEND_URL (lib/env). */
export const DEV_BACKEND_URL = "http://localhost:9000";

export type FileProviderEntry =
  | { resolve: "./src/lib/upload"; id: "local"; options: { private_upload_dir: string } }
  | { resolve: "./src/lib/upload/s3"; id: "s3"; options: SharedS3Options };

export function fileProviderEntry(input: FileStorageInput): FileProviderEntry {
  const storage = input.fileStorage;
  if (storage.kind === "local") {
    return {
      resolve: "./src/lib/upload",
      id: "local",
      options: { private_upload_dir: input.privateUploadDir },
    };
  }
  return {
    resolve: "./src/lib/upload/s3",
    id: "s3",
    options: {
      endpoint: storage.endpoint,
      region: storage.region,
      bucket: storage.bucket,
      private_bucket: storage.privateBucket,
      file_url: storage.fileUrl,
      access_key_id: storage.accessKeyId,
      secret_access_key: storage.secretAccessKey,
      force_path_style: storage.forcePathStyle,
      backend_url: input.backendUrl ?? DEV_BACKEND_URL,
    },
  };
}
