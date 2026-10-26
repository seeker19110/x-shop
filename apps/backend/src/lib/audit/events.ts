/**
 * Danh mục tên sự kiện audit bảo mật (SEC-LOG-001) — nguồn duy nhất cho mã và cho bảng ở
 * `docs/security/security-events.md` (test `security-events.unit.spec.ts` đối chiếu hai bên: thêm sự kiện ở đây mà quên
 * tài liệu → đỏ). Tên = cột `action` của `audit_log`, cũng là `event.name` của dòng log `security.audit`.
 */
export const SECURITY_EVENTS = {
  // Xác thực — ghi theo route bởi lib/audit/http.ts (securityAuditTrail)
  LOGIN: "auth.login",
  LOCKOUT: "auth.lockout",
  LOGOUT: "auth.logout",
  SESSION_CREATED: "auth.session_created",
  TOKEN_REFRESHED: "auth.token_refreshed",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_CHANGED: "auth.password_changed",
  MFA_ENROLL_STARTED: "auth.mfa.enroll_started",
  MFA_ENROLLED: "auth.mfa.enrolled",
  MFA_FACTOR_REMOVED: "auth.mfa.factor_removed",
  MFA_RECOVERY_CODES_ISSUED: "auth.mfa.recovery_codes_issued",
  MFA_VERIFIED: "auth.mfa.verified",
  // Phân quyền — cổng RBAC (lib/admin-security/guard.ts) và route vai trò
  RBAC_DENIED: "rbac.denied",
  ROLE_GRANTED: "rbac.role_granted",
  ROLE_REVOKED: "rbac.role_revoked",
  // Dữ liệu — ghi theo route bởi lib/audit/http.ts
  DATA_EXPORTED: "data.exported",
  DATA_ACCESSED: "data.accessed",
} as const;

export type SecurityEventName = (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS];

export const SECURITY_EVENT_NAMES: readonly SecurityEventName[] = Object.values(SECURITY_EVENTS);
