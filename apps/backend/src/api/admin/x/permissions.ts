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
  /** Quyền bổ sung — cần ĐỦ cả `permission` lẫn mọi quyền ở đây (vd. commit import ghi cả giá và tồn). */
  also?: readonly Permission[];
  reauth?: boolean;
}

/** Mọi quyền một route đòi (chính + bổ sung). */
export const requiredPermissions = (r: Pick<AdminXRoute, "permission" | "also">): Permission[] => [
  r.permission,
  ...(r.also ?? []),
];

export const ADMIN_X_PERMISSIONS: readonly AdminXRoute[] = [
  // Catalog thời trang (T-013/T-015)
  { method: "GET", path: "/admin/x/size-charts", permission: "catalog.read" },
  { method: "POST", path: "/admin/x/size-charts", permission: "catalog.write" },
  { method: "POST", path: "/admin/x/size-charts/:code/revise", permission: "catalog.write" },
  { method: "POST", path: "/admin/x/products/:id/fashion", permission: "catalog.write" },
  { method: "GET", path: "/admin/x/products/:id/publish-check", permission: "catalog.read" },
  // Nhập/xuất CSV catalog (T-015). Commit ghi cả giá và tồn → cần đủ ba quyền (ý định của route, ADM02).
  { method: "POST", path: "/admin/x/imports/preview", permission: "catalog.import" },
  { method: "GET", path: "/admin/x/imports/:id", permission: "catalog.import" },
  {
    method: "POST",
    path: "/admin/x/imports/:id/commit",
    permission: "catalog.import",
    also: ["price.write", "inventory.adjust"],
  },
  { method: "GET", path: "/admin/x/exports/products.csv", permission: "catalog.read" },
  // Vai trò (T-023)
  { method: "GET", path: "/admin/x/users/:id/roles", permission: "user.manage" },
  { method: "POST", path: "/admin/x/users/:id/roles", permission: "user.manage", reauth: true },
  { method: "DELETE", path: "/admin/x/users/:id/roles", permission: "user.manage", reauth: true },
  // Hoàn tiền (T-027, S-108, S-403): CSKH/kế toán tạo yêu cầu; người thứ hai có refund.approve duyệt; kế toán thực
  // hiện. Xác thực lại MFA khi vượt ngưỡng kiểm TRONG route (biết số tiền mới biết vượt ngưỡng).
  { method: "GET", path: "/admin/x/refunds", permission: "refund.request" },
  { method: "POST", path: "/admin/x/refunds", permission: "refund.request" },
  { method: "POST", path: "/admin/x/refunds/:id/approve", permission: "refund.approve" },
  { method: "POST", path: "/admin/x/refunds/:id/reject", permission: "refund.approve" },
  { method: "POST", path: "/admin/x/refunds/:id/execute", permission: "refund.execute" },
  // Đổi trả theo dòng (T-027, POST03, INV04): CSKH tạo/duyệt, kho nhận + kiểm định.
  { method: "POST", path: "/admin/x/returns", permission: "return.request" },
  { method: "POST", path: "/admin/x/returns/:id/approve", permission: "return.approve" },
  { method: "POST", path: "/admin/x/returns/:id/reject", permission: "return.approve" },
  { method: "POST", path: "/admin/x/returns/:id/receive", permission: "return.receive" },
  { method: "POST", path: "/admin/x/returns/:id/inspect", permission: "return.inspect" },
  // Đơn hàng + giao vận (T-026): nhân viên đơn xác nhận COD và tạo vận đơn (đặc tả §5.4).
  { method: "POST", path: "/admin/x/orders/:id/confirm-cod", permission: "order.confirm" },
  { method: "POST", path: "/admin/x/orders/:id/shipments", permission: "fulfillment.create" },
  // Đối soát COD/sao kê + báo cáo/dashboard ngoại lệ (T-028, §5.5, AT14): kế toán nhập chứng từ (settlement.import —
  // nhạy cảm, đòi MFA) và đóng chênh lệch; báo cáo theo report.read, dashboard theo exception.read.
  { method: "POST", path: "/admin/x/settlements/batches", permission: "settlement.import" },
  { method: "GET", path: "/admin/x/settlements/batches", permission: "settlement.read" },
  { method: "GET", path: "/admin/x/settlements/batches/:id", permission: "settlement.read" },
  { method: "GET", path: "/admin/x/settlements/discrepancies", permission: "settlement.read" },
  {
    method: "POST",
    path: "/admin/x/settlements/discrepancies/:id/resolve",
    permission: "exception.resolve",
    also: ["settlement.read"],
  },
  { method: "GET", path: "/admin/x/reports/summary", permission: "report.read" },
  { method: "GET", path: "/admin/x/reports/exceptions", permission: "exception.read" },
  // Audit + điều chỉnh tồn (T-025)
  { method: "GET", path: "/admin/x/audit", permission: "audit.read" },
  { method: "POST", path: "/admin/x/inventory/adjustments", permission: "inventory.adjust" },
];
