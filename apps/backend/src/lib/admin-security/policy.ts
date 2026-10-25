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
