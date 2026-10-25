import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { sendProblem } from "../http/problem";
import { getHttpSecurityConfig, type OriginList } from "./config";

/**
 * Chống CSRF cho thao tác ghi dùng cookie (SEC01). Phiên Medusa (`connect.sid`, HttpOnly, production SameSite=Lax +
 * Secure) được trình duyệt gửi kèm tự động — SameSite=Lax vẫn cho subdomain cùng "site" (vd. trang độc ở
 * `*.example.vn`) gửi kèm. Vì vậy request ghi (POST/PUT/PATCH/DELETE) CÓ cookie phải chứng minh đến từ origin được phép:
 *
 *  - `Origin` có mặt → phải thuộc allowlist của namespace (CÙNG danh sách CORS: STORE_CORS / ADMIN_CORS / AUTH_CORS),
 *    hoặc trình duyệt báo `Sec-Fetch-Site: same-origin` (header cấm — trang khác không giả được). `Origin: null` (iframe
 *    sandbox, data:, file:) → luôn từ chối.
 *  - Không có `Origin`: `Sec-Fetch-Site` là `cross-site`/`same-site` → từ chối; còn lại (client không phải trình duyệt,
 *    điều hướng do người dùng gõ) → cho qua.
 *
 * Request KHÔNG có cookie (Bearer, publishable key, server-to-server từ storefront, webhook) không mang thẩm quyền ngầm →
 * không phải đối tượng CSRF, cho qua.
 */
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type CsrfVerdict =
  { ok: true } | { ok: false; reason: "origin_null" | "origin_not_allowed" | "cross_site" };

export interface CsrfInput {
  method: string;
  cookie: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  allowed: OriginList;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function originAllowed(origin: string, allowed: OriginList): boolean {
  return allowed.some((entry) => (typeof entry === "string" ? entry === origin : entry.test(origin)));
}

export function checkCsrf(input: CsrfInput): CsrfVerdict {
  if (!UNSAFE.has(input.method.toUpperCase())) return { ok: true };
  if (!input.cookie || input.cookie.trim() === "") return { ok: true };
  const site = input.secFetchSite?.trim().toLowerCase();
  const origin = input.origin?.trim();
  if (origin !== undefined && origin !== "") {
    if (origin.toLowerCase() === "null") return { ok: false, reason: "origin_null" };
    if (site === "same-origin" || originAllowed(origin, input.allowed)) return { ok: true };
    return { ok: false, reason: "origin_not_allowed" };
  }
  if (site === "cross-site" || site === "same-site") return { ok: false, reason: "cross_site" };
  return { ok: true };
}

type Namespace = "store" | "admin" | "auth";

export function csrfGuard(namespace: Namespace) {
  return (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
    const verdict = checkCsrf({
      method: req.method,
      cookie: first(req.headers.cookie),
      origin: first(req.headers.origin),
      secFetchSite: first(req.headers["sec-fetch-site"]),
      allowed: getHttpSecurityConfig().origins[namespace],
    });
    if (verdict.ok) return next();
    sendProblem(res, 403, "CSRF_REJECTED", "Yêu cầu bị từ chối: nguồn gửi không được phép", [], {
      reason: verdict.reason,
    });
  };
}
