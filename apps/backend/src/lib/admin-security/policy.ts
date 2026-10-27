import type { Permission } from "@x-shop/domain";
import { ADMIN_X_PERMISSIONS } from "../../api/admin/x/permissions";
import { resolveNativeRule, type NativeDenyReason } from "./native-permissions";
import { matchPath } from "./route-match";

/** Quy tắc truy cập đã phân giải cho một request admin (method đã chuẩn hoá, path đã chuẩn hoá). */
export type AdminRule =
  | { kind: "public" }
  | { kind: "self" }
  | { kind: "any_role" }
  | { kind: "deny"; reason: "UNDECLARED_ROUTE" | NativeDenyReason }
  | { kind: "permission"; permission: Permission; also: readonly Permission[]; reauth: boolean };

export const ADMIN_X_PREFIX = "/admin/x";

export const isAdminXPath = (path: string) =>
  path === ADMIN_X_PREFIX || path.startsWith(`${ADMIN_X_PREFIX}/`);

/** Path (đã chuẩn hoá) thuộc `/admin` — cổng gắn ở matcher `/admin` nên path phân giải phải thoả, khác là lệch parse. */
export const isAdminPath = (path: string) => path === "/admin" || path.startsWith("/admin/");

const STRICTNESS: Record<AdminRule["kind"], number> = {
  public: 0,
  self: 1,
  any_role: 2,
  permission: 3,
  deny: 4,
};

/**
 * Quy tắc chặt hơn của hai (T-145): khi path giải mã `%xx` khác path router khớp (chưa giải mã), cổng phải thoả CẢ HAI —
 * giải mã không được đưa request về quy tắc lỏng hơn (`/admin/users/%6De` → `self`) cũng như chuỗi thô không được rơi
 * xuống mặc định lỏng (`/admin/%63ustomers/1` → `any_role`). Hai quy tắc quyền → cần mọi quyền của cả hai, reauth nếu một
 * bên đòi.
 */
export function strictestRule(a: AdminRule, b: AdminRule): AdminRule {
  if (a.kind === "permission" && b.kind === "permission") {
    const [first, ...rest] = [...new Set([a.permission, ...a.also, b.permission, ...b.also])];
    return {
      kind: "permission",
      permission: first ?? a.permission,
      also: rest,
      reauth: a.reauth || b.reauth,
    };
  }
  return STRICTNESS[a.kind] >= STRICTNESS[b.kind] ? a : b;
}

export function resolveAdminRule(method: string, path: string): AdminRule {
  if (isAdminXPath(path)) {
    const hit = ADMIN_X_PERMISSIONS.find((r) => r.method === method && matchPath(r.path, path));
    return hit
      ? { kind: "permission", permission: hit.permission, also: hit.also ?? [], reauth: hit.reauth === true }
      : { kind: "deny", reason: "UNDECLARED_ROUTE" };
  }
  const native = resolveNativeRule(method, path, matchPath);
  return native.kind === "permission" ? { ...native, also: [], reauth: false } : native;
}
