import type { NodeEnv } from "../env";

/**
 * Cookie phiên admin (BE-AUTH-004, T-099). Medusa 2.22.1 (`@medusajs/framework` http/express-loader) dựng express-session
 * với `name: projectConfig.sessionOptions.name ?? "connect.sid"` và `cookie: { sameSite, secure, maxAge, ...projectConfig.cookieOptions }`
 * (production: `sameSite: "lax"`, `secure: true`); đăng xuất (`DELETE /auth/session`) xoá cookie theo đúng
 * `sessionOptions.name` + `cookieOptions` → cấu hình được, không cần vá Medusa.
 *
 * Production: tên `__Host-…` — trình duyệt chỉ nhận khi có `Secure`, `Path=/` và KHÔNG có `Domain` → subdomain khác
 * (cùng site) không ghi đè/cấy được cookie phiên (chống session fixation qua subdomain). Dev/test chạy http://localhost:
 * cookie không `Secure` nên KHÔNG được dùng tiền tố `__Host-` (trình duyệt sẽ bỏ cookie) → giữ mặc định của Medusa.
 */
export const ADMIN_SESSION_COOKIE_NAME = "__Host-xshop_sid";

export interface SessionCookieConfig {
  sessionOptions?: { name: string };
  cookieOptions?: { secure: true; httpOnly: true; sameSite: "lax"; path: "/" };
}

export function sessionCookieConfig(nodeEnv: NodeEnv): SessionCookieConfig {
  if (nodeEnv !== "production") return {};
  return {
    sessionOptions: { name: ADMIN_SESSION_COOKIE_NAME },
    // Không đặt `domain` (bắt buộc với __Host-). Ghi rõ dù trùng mặc định production của Medusa: cấu hình là nguồn sự thật.
    cookieOptions: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
  };
}
