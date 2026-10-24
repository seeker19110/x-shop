import type { MedusaRequest } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import type { Permission } from "@x-shop/domain";

type WithAuth = MedusaRequest & { auth_context?: { actor_id?: string; actor_type?: string } };

/**
 * ĐIỂM GẮN RBAC (T-023): mọi route `/admin/x/*` cần quyền gọi hàm này với quyền cụ thể. Hiện chỉ đòi actor là admin
 * đã đăng nhập (Medusa đã chặn chưa đăng nhập ở /admin/*); T-023 thay thân hàm bằng tra vai trò → quyền
 * (`ROLE_GRANTS`, packages/domain/src/access) và trả 403 khi thiếu. Trả actor_id để ghi người thao tác.
 */
export function requirePermission(req: MedusaRequest, ...permissions: Permission[]): string {
  const auth = (req as WithAuth).auth_context;
  if (!auth?.actor_id || auth.actor_type !== "user") {
    throw new MedusaError(
      MedusaError.Types.UNAUTHORIZED,
      `Cần đăng nhập quản trị (${permissions.join(", ")})`,
    );
  }
  return auth.actor_id;
}
