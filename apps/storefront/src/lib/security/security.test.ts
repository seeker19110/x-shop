// @vitest-environment node
import { NextRequest } from "next/server";
import nextConfig from "../../../next.config";
import { config as proxyConfig, proxy } from "../../proxy";
import { buildCsp, createNonce, HSTS_VALUE } from "./csp";
import { allowedHostsOf, checkCsrf } from "./csrf";
import { forwardedClientIp, trustProxyHeaders } from "./client-ip";

/** T-034 — bảo mật storefront: CSP nonce, header, CSRF ở proxy, chuyển tiếp IP khách chỉ khi tin proxy. */

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

describe("buildCsp", () => {
  const csp = buildCsp({ nonce: "abc123", dev: false, production: true });

  it("script chỉ chạy với nonce + strict-dynamic; không unsafe-inline/unsafe-eval cho script", () => {
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
  });

  it("chống nhúng khung, plugin, base, form ra ngoài; nâng http trong production", () => {
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("dev: thêm unsafe-eval (React dev) và ws cho HMR; ngoài production không upgrade-insecure-requests", () => {
    const dev = buildCsp({ nonce: "n", dev: true, production: false });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ nonce: "n", dev: false, production: false })).not.toContain("unsafe-eval");
  });

  it("nonce ngẫu nhiên 128 bit, base64, không lặp", () => {
    const set = new Set(Array.from({ length: 200 }, () => createNonce()));
    expect(set.size).toBe(200);
    for (const n of set) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("checkCsrf", () => {
  const hosts = ["shop.example.vn", "localhost:3000"];
  const v = (method: string, origin: string | null, secFetchSite: string | null = null) =>
    checkCsrf({ method, origin, secFetchSite, allowedHosts: hosts });

  it("phương thức an toàn luôn qua", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"])
      expect(v(m, "https://evil.example", "cross-site").ok).toBe(true);
  });

  it("origin cùng host → qua; host lạ / khác cổng / subdomain / scheme lạ → từ chối", () => {
    expect(v("POST", "https://shop.example.vn").ok).toBe(true);
    expect(v("post", "http://localhost:3000").ok).toBe(true);
    for (const o of [
      "https://evil.example",
      "http://localhost:3001",
      "https://a.shop.example.vn",
      "https://shop.example.vn.evil.example",
      "javascript:alert(1)",
      "foo",
    ]) {
      expect(v("POST", o)).toEqual({ ok: false, reason: "origin_not_allowed" });
    }
  });

  it('origin "null" → từ chối', () => {
    expect(v("POST", "null")).toEqual({ ok: false, reason: "origin_null" });
    expect(v("DELETE", " NULL ", "same-origin")).toEqual({ ok: false, reason: "origin_null" });
  });

  it("không Origin: cross-site/same-site → từ chối; same-origin/none/vắng/rỗng → qua", () => {
    expect(v("POST", null, "cross-site")).toEqual({ ok: false, reason: "cross_site" });
    expect(v("POST", "", "same-site")).toEqual({ ok: false, reason: "cross_site" });
    expect(v("POST", null, "same-origin").ok).toBe(true);
    expect(v("POST", null, "none").ok).toBe(true);
    expect(v("POST", null, null).ok).toBe(true);
  });

  it("allowedHostsOf: x-forwarded-host (mục đầu), host, NEXT_PUBLIC_SITE_URL; bỏ giá trị hỏng", () => {
    const h = new Headers({ host: "internal:3000", "x-forwarded-host": "Shop.Example.vn, proxy.local" });
    expect(allowedHostsOf(h, "https://www.example.vn/").sort()).toEqual(
      ["internal:3000", "shop.example.vn", "www.example.vn"].sort(),
    );
    expect(allowedHostsOf(new Headers(), "khong-phai-url")).toEqual([]);
  });
});

describe("proxy", () => {
  const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(new URL(url), { method: init.method ?? "GET", headers: init.headers });
  afterEach(() => vi.unstubAllEnvs());

  it("GET trang: CSP có nonce mới mỗi request, cùng nonce chuyển cho Next qua header request; không HSTS ngoài production", () => {
    const a = proxy(req("http://localhost:3000/san-pham/ao"));
    const b = proxy(req("http://localhost:3000/san-pham/ao"));
    const cspA = a.headers.get("content-security-policy") ?? "";
    const nonceA = /'nonce-([^']+)'/.exec(cspA)?.[1];
    const nonceB = /'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(cspA);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonceA);
    expect(a.headers.get("strict-transport-security")).toBeNull();
    expect(a.status).toBe(200);
  });

  it("production: HSTS + upgrade-insecure-requests", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = proxy(req("https://shop.example.vn/"));
    expect(res.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    expect(res.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
  });

  it.each([
    ["origin lạ", { origin: "https://evil.example" }],
    ['origin "null"', { origin: "null" }],
    ["Sec-Fetch-Site cross-site, không Origin", { "sec-fetch-site": "cross-site" }],
  ])("Server Action / POST với %s → 403 CSRF_REJECTED", async (_l, headers) => {
    const res = proxy(
      req("http://localhost:3000/thanh-toan", {
        method: "POST",
        headers: { "next-action": "abc", ...headers },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CSRF_REJECTED" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POST cùng origin / qua proxy x-forwarded-host / theo NEXT_PUBLIC_SITE_URL → qua", () => {
    expect(
      proxy(
        req("http://localhost:3000/api/analytics", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        }),
      ).status,
    ).toBe(200);
    expect(
      proxy(
        req("http://10.0.0.5:3000/thanh-toan", {
          method: "POST",
          headers: { origin: "https://shop.example.vn", "x-forwarded-host": "shop.example.vn" },
        }),
      ).status,
    ).toBe(200);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.example.vn");
    expect(
      proxy(
        req("http://10.0.0.5:3000/gio-hang", {
          method: "POST",
          headers: { origin: "https://www.example.vn" },
        }),
      ).status,
    ).toBe(200);
  });

  it("matcher: bỏ tài nguyên tĩnh, áp cho trang và /api", () => {
    const m = proxyConfig.matcher[0]!;
    const re = new RegExp(`^${m.source}$`);
    for (const p of ["/", "/san-pham/ao", "/api/analytics", "/thanh-toan", "/tra-cuu-don/xac-thuc"]) {
      expect(re.test(p)).toBe(true);
    }
    for (const p of [
      "/_next/static/chunks/a.js",
      "/_next/image",
      "/icons/icon.svg",
      "/sw.js",
      "/demo/a.svg",
    ]) {
      expect(re.test(p)).toBe(false);
    }
    expect(m.missing).toEqual(expect.arrayContaining([{ type: "header", key: "next-router-prefetch" }]));
  });
});

describe("next.config: header tĩnh cho mọi đường", () => {
  it("nosniff, chống nhúng khung, Referrer-Policy, Permissions-Policy, COOP; không CSP trùng (CSP ở proxy)", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const map = new Map(all.headers.map((h) => [h.key, h.value]));
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toContain("camera=()");
    expect(map.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(map.has("Content-Security-Policy")).toBe(false);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("IP khách chuyển tiếp cho backend", () => {
  const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;

  it("mặc định không tin header proxy → không chuyển tiếp", () => {
    expect(trustProxyHeaders({})).toBe(false);
    expect(trustProxyHeaders({ XS_TRUST_PROXY_HEADERS: "false" })).toBe(false);
    expect(trustProxyHeaders({ XS_TRUST_PROXY_HEADERS: " TRUE " })).toBe(true);
    expect(forwardedClientIp(h({ "x-forwarded-for": "1.2.3.4" }), false)).toBeNull();
  });

  it("tin: x-real-ip trước, rồi mục CUỐI của XFF; IPv6; rác/rỗng → null", () => {
    expect(
      forwardedClientIp(h({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), true),
    ).toBe("9.9.9.9");
    expect(forwardedClientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), true)).toBe("203.0.113.9");
    expect(forwardedClientIp(h({ "x-forwarded-for": "2001:db8::1" }), true)).toBe("2001:db8::1");
    expect(forwardedClientIp(h({ "x-forwarded-for": "<script>" }), true)).toBeNull();
    expect(forwardedClientIp(h({ "x-forwarded-for": " , " }), true)).toBeNull();
    expect(forwardedClientIp(h({}), true)).toBeNull();
  });

  it("x-real-ip rỗng/toàn khoảng trắng coi như thiếu → lấy mục cuối XFF (BASE-DATA-003)", () => {
    expect(forwardedClientIp(h({ "x-real-ip": "", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), true)).toBe(
      "2.2.2.2",
    );
    expect(forwardedClientIp(h({ "x-real-ip": "  ", "x-forwarded-for": "2.2.2.2" }), true)).toBe("2.2.2.2");
    expect(forwardedClientIp(h({ "x-real-ip": "" }), true)).toBeNull();
  });
});
