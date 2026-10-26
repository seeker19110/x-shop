import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, createNonce, HSTS_VALUE } from "./lib/security/csp";
import { allowedHostsOf, checkCsrf } from "./lib/security/csrf";

/**
 * Proxy (Next 16 đổi tên `middleware` → `proxy`, chạy Node.js runtime) — T-034:
 *  1. CSRF: request ghi từ origin lạ / `null` / `Sec-Fetch-Site: cross-site` → 403 (lib/security/csrf.ts).
 *  2. CSP nonce mỗi request (lib/security/csp.ts): đặt trên REQUEST để Next gắn nonce cho script của nó, và trên phản hồi.
 *  3. HSTS ở production.
 * Header tĩnh (nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cache-Control riêng tư) ở next.config.ts.
 */
export function proxy(request: NextRequest): NextResponse {
  const production = process.env.NODE_ENV === "production";
  const verdict = checkCsrf({
    method: request.method,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    allowedHosts: [
      ...allowedHostsOf(request.headers, process.env.NEXT_PUBLIC_SITE_URL),
      request.nextUrl.host.toLowerCase(),
    ],
  });
  if (!verdict.ok) {
    const res = NextResponse.json(
      { code: "CSRF_REJECTED", reason: verdict.reason },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
    if (production) res.headers.set("Strict-Transport-Security", HSTS_VALUE);
    return res;
  }

  const nonce = createNonce();
  const csp = buildCsp({ nonce, dev: process.env.NODE_ENV === "development", production });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  if (production) res.headers.set("Strict-Transport-Security", HSTS_VALUE);
  return res;
}

export const config = {
  matcher: [
    {
      // Bỏ tài nguyên tĩnh (không cần CSP/nonce) và prefetch của next/link (GET, không render HTML mới).
      source:
        "/((?!_next/static|_next/image|favicon.ico|icons/|demo/|sw.js|manifest.webmanifest|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
