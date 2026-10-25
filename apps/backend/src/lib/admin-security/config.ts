import type { Permission } from "@x-shop/domain";
import { parseEnv } from "../env";

/**
 * Tham số bảo mật admin (T-023/T-024). Thời hạn phiên đọc từ env (đã kiểm ở medusa-config, docs/ops/ENV.md); ngưỡng
 * rate limit là hằng có tên (đổi một chỗ).
 */
export interface AdminSessionPolicy {
  /** Hết hạn tuyệt đối tính từ lúc xác thực (MFA hoặc đăng nhập), giây. */
  maxAgeSeconds: number;
  /** Nhàn rỗi tối đa giữa hai request admin, giây. */
  idleSeconds: number;
  /** Xác thực lại MFA cho thao tác nhạy cảm (đổi quyền, hoàn tiền vượt ngưỡng), giây. */
  reauthMaxAgeSeconds: number;
}

let cached: AdminSessionPolicy | null = null;

export function getAdminSessionPolicy(): AdminSessionPolicy {
  if (cached) return cached;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[admin-security] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cached = {
    maxAgeSeconds: parsed.env.ADMIN_SESSION_MAX_AGE_SECONDS,
    idleSeconds: parsed.env.ADMIN_SESSION_IDLE_SECONDS,
    reauthMaxAgeSeconds: parsed.env.ADMIN_REAUTH_MAX_AGE_SECONDS,
  };
  return cached;
}

/** Quyền nhạy cảm: route cần quyền này đòi MFA đã xác minh trong phiên (SEC02, T-024). */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  "user.manage",
  "refund.request",
  "refund.approve",
  "refund.execute",
  "settings.manage",
  "customer.export",
  "settlement.import",
];

export const isSensitive = (perm: Permission): boolean => SENSITIVE_PERMISSIONS.includes(perm);

/**
 * Rate limit đăng nhập/MFA theo NHIỀU tín hiệu (SEC03): chỉ đếm lần THẤT BẠI trong cửa sổ trượt cố định.
 *  - (định danh + IP): chặn đoán mật khẩu/mã từ một nơi — ngưỡng thấp;
 *  - định danh (mọi IP): chặn đoán phân tán vào một tài khoản — ngưỡng vừa;
 *  - IP (mọi định danh): chỉ chặn quét hàng loạt — ngưỡng CAO để không khoá cả mạng dùng chung (NAT công ty/quán cà phê).
 */
export const AUTH_RATE_LIMITS = {
  windowSeconds: 15 * 60,
  login: { perIdentityIp: 5, perIdentity: 20, perIp: 100 },
  mfa: { perIdentityIp: 5, perIdentity: 10, perIp: 100 },
} as const;
