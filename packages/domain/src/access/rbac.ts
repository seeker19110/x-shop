/**
 * Ma trận vai trò → quyền là DỮ LIỆU (SPEC-admin, đặc tả §5.4). Backend kiểm ở mọi route `/admin/x/*` (ADM04, AT21).
 * Quyền dạng `nhóm.hành_động`; `nhóm.*` cho mọi hành động trong nhóm; `*` chỉ cho owner.
 */
export const ROLES = [
  "owner",
  "catalog_manager",
  "order_staff",
  "warehouse",
  "support",
  "accountant",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "catalog.read",
  "catalog.write",
  "catalog.publish",
  "catalog.import",
  "content.write",
  "price.write",
  "inventory.read",
  "inventory.adjust",
  "order.read",
  "order.read_masked",
  "order.confirm",
  "order.cancel",
  "fulfillment.create",
  "fulfillment.update",
  "return.request",
  "return.approve",
  "return.receive",
  "return.inspect",
  "refund.request",
  "refund.approve",
  "refund.execute",
  "payment.read",
  /**
   * Ghi đè trạng thái thanh toán CHƯA XÁC MINH (T-165, D-118): hủy đơn `awaiting_payment` có attempt `unknown`/pending quá
   * hạn sau khi đối chiếu tay trên cổng merchant. Không vai trò nào ngoài `owner` (`*`) có — kể cả kế toán (`payment.read`
   * là quyền đọc, không phải `payment.*`); cấp thêm là đổi ma trận có chủ đích.
   */
  "payment.override",
  "settlement.read",
  "settlement.import",
  "report.read",
  "exception.read",
  "exception.resolve",
  "customer.export",
  "user.manage",
  "settings.manage",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_GRANTS: Record<Role, readonly string[]> = {
  owner: ["*"],
  catalog_manager: ["catalog.*", "content.*", "price.write", "inventory.read", "report.read"],
  order_staff: [
    "order.read",
    "order.confirm",
    "order.cancel",
    "fulfillment.*",
    "inventory.read",
    "exception.read",
  ],
  warehouse: ["inventory.*", "return.receive", "return.inspect", "fulfillment.update", "catalog.read"],
  support: ["order.read_masked", "return.request", "return.approve", "refund.request", "exception.read"],
  accountant: [
    "order.read",
    "payment.read",
    "refund.*",
    "settlement.*",
    "report.read",
    "exception.read",
    "exception.resolve",
  ],
};

function grantMatches(grant: string, perm: string): boolean {
  if (grant === "*") return true;
  if (grant.endsWith(".*")) return perm.startsWith(grant.slice(0, -1));
  return grant === perm;
}

/** Từ chối mặc định: vai trò lạ, danh sách rỗng hay quyền lạ đều là `false`. */
export function can(roles: readonly string[], perm: Permission): boolean {
  if (!(PERMISSIONS as readonly string[]).includes(perm)) return false;
  return roles.some(
    (r) =>
      (ROLES as readonly string[]).includes(r) && ROLE_GRANTS[r as Role].some((g) => grantMatches(g, perm)),
  );
}

export function permissionsOf(roles: readonly string[]): Permission[] {
  return PERMISSIONS.filter((p) => can(roles, p));
}

/** Hoàn tiền vượt ngưỡng cần người thứ hai có `refund.approve`, khác người tạo (S-403). */
export function refundNeedsSecondApproval(amount: number, threshold: number): boolean {
  return amount > threshold;
}

export function canApproveRefund(
  approver: { id: string; roles: readonly string[] },
  requestedBy: string,
): { ok: true } | { ok: false; reason: "SELF_APPROVAL" | "FORBIDDEN" } {
  if (!can(approver.roles, "refund.approve")) return { ok: false, reason: "FORBIDDEN" };
  if (approver.id === requestedBy) return { ok: false, reason: "SELF_APPROVAL" };
  return { ok: true };
}

/** Che PII cho vai trò chỉ được xem dữ liệu đã che (CSKH): "0912345678" → "091****678". */
export function maskPhone(phone: string): string {
  return phone.length < 7 ? "***" : `${phone.slice(0, 3)}${"*".repeat(phone.length - 6)}${phone.slice(-3)}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
