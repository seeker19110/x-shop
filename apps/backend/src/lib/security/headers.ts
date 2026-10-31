import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getHttpSecurityConfig } from "./config";

/**
 * Header bảo mật cho phản hồi API JSON của backend (SEC05): `/store`, `/admin` (API), `/auth`, `/x`. Không áp cho giao
 * diện Admin native (`/app`) — trang đó có CSP riêng của Medusa/Vite.
 *
 * CSP của API: không tài nguyên nào được nạp/thực thi, không được nhúng khung — phản hồi JSON bị mở thẳng trên trình duyệt
 * cũng không chạy được gì. HSTS chỉ ở production (trình duyệt bỏ qua HSTS trên http, nhưng không ghim localhost dev).
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

export function apiSecurityHeaders(production: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": API_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(production && { "Strict-Transport-Security": HSTS_VALUE }),
  };
}

export function securityHeaders(_req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  for (const [k, v] of Object.entries(apiSecurityHeaders(getHttpSecurityConfig().production))) {
    // Chỉ đặt khi chưa có; giá trị rỗng coi như chưa đặt (giữ hành vi cũ — header bảo mật rỗng không có tác dụng).
    const current = res.getHeader(k);
    if (current === undefined || current === "") res.setHeader(k, v);
  }
  // Không quảng cáo framework/phiên bản (Express đặt mặc định).
  res.removeHeader("X-Powered-By");
  next();
}
