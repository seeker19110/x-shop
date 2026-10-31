import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { SharedS3FileService } from "./provider";

/**
 * Provider của File Module khi `FILE_STORAGE=s3` (đăng ký trong `medusa-config.ts`, T-154): kho S3-compatible dùng chung
 * giữa các bản sao, bucket công khai + bucket private, khoá do server sinh.
 */
export default ModuleProvider(Modules.FILE, { services: [SharedS3FileService] });

export { SharedS3FileService, type SharedS3Options } from "./provider";
