import type { Permission } from "@x-shop/domain";

/**
 * Map TẬP TRUNG quyền cho mọi route `/admin/x/*` (T-023, ADM04, AT21): method + mẫu đường dẫn → một Permission của
 * ma trận `ROLE_GRANTS` (@x-shop/domain). Middleware RBAC (src/lib/admin-security/guard.ts) đọc map này; route KHÔNG có
 * mục ở đây → 403 (fail-closed). Thêm route mới dưới `src/api/admin/x/` mà quên khai báo → test `rbac` đỏ (quét thư mục).
 *
 * `reauth`: thao tác cần xác thực lại MFA gần đây (≤ ADMIN_REAUTH_MAX_AGE_SECONDS, mặc định 5 phút — SPEC-admin S-402).
 * MFA đã xác minh được đòi theo QUYỀN (SENSITIVE_PERMISSIONS ở guard), không cần khai lại ở đây.
 */
export type AdminHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface AdminXRoute {
  method: AdminHttpMethod;
  /** Mẫu Express: `:param` khớp một đoạn. */
  path: string;
  permission: Permission;
  reauth?: boolean;
}

export const ADMIN_X_PERMISSIONS: readonly AdminXRoute[] = [
  // Catalog thời trang (T-013/T-015)
  { method: "GET", path: "/admin/x/size-charts", permission: "catalog.read" },
  { method: "POST", path: "/admin/x/size-charts", permission: "catalog.write" },
  { method: "POST", path: "/admin/x/size-charts/:code/revise", permission: "catalog.write" },
  { method: "POST", path: "/admin/x/products/:id/fashion", permission: "catalog.write" },
  { method: "GET", path: "/admin/x/products/:id/publish-check", permission: "catalog.read" },
  // Vai trò (T-023)
  { method: "GET", path: "/admin/x/users/:id/roles", permission: "user.manage" },
  { method: "POST", path: "/admin/x/users/:id/roles", permission: "user.manage", reauth: true },
  { method: "DELETE", path: "/admin/x/users/:id/roles", permission: "user.manage", reauth: true },
  // Hoàn tiền (stub 501 tới T-027; xác thực lại khi vượt ngưỡng do T-027 kiểm theo số tiền)
  { method: "POST", path: "/admin/x/refunds", permission: "refund.execute" },
];
