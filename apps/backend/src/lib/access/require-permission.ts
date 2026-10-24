import type { MedusaRequest } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { can, type Permission } from "@x-shop/domain";
import { adminAccessOf } from "../admin-security/guard";

/**
 * Kiểm quyền TRONG route (lớp phòng thủ thứ hai, T-023). Lớp chính là guard `/admin/*` (lib/admin-security/guard.ts)
 * theo map `api/admin/x/permissions.ts`; hàm này đòi guard ĐÃ chạy cho request (có vai trò đã nạp) và vai trò có ĐỦ mọi
 * quyền nêu ra — route bị gỡ khỏi map hay map khai quyền lỏng hơn route cần vẫn bị chặn. Trả actor_id để ghi người làm.
 */
export function requirePermission(req: MedusaRequest, ...permissions: Permission[]): string {
  const access = adminAccessOf(req);
  if (!access) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Cần đăng nhập quản trị");
  }
  const missing = permissions.filter((p) => !can(access.roles, p));
  if (missing.length > 0) {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, `Thiếu quyền: ${missing.join(", ")}`);
  }
  return access.userId;
}
