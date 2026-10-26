import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { ServerKeyedLocalFileService } from "./provider";

/** Provider của File Module (đăng ký trong `medusa-config.ts`): local + tên lưu do server sinh (T-100). */
export default ModuleProvider(Modules.FILE, { services: [ServerKeyedLocalFileService] });

export { ServerKeyedLocalFileService } from "./provider";
export { generateUploadKey, extensionForMime, UPLOAD_MIME_EXTENSIONS } from "./key";
