import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import { TimingSafeEmailPassAuthService } from "./service";

/** Provider Auth `emailpass` cân thời gian phản hồi (đăng ký trong `medusa-config.ts`, BE-AUTH-003, T-099). */
export default ModuleProvider(Modules.AUTH, { services: [TimingSafeEmailPassAuthService] });

export { TimingSafeEmailPassAuthService } from "./service";
