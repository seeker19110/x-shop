import type { NextConfig } from "next";

/** Ảnh phục vụ từ backend (`/static/...`, chỉ có ở dev; production dùng CDN — thêm host CDN vào đây khi biết). */
function backendImagePatterns(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const raw = process.env.MEDUSA_BACKEND_URL?.trim();
  if (!raw) return [];
  try {
    const u = new URL(raw);
    const protocol = u.protocol === "https:" ? "https" : "http";
    return [{ protocol, hostname: u.hostname, ...(u.port ? { port: u.port } : {}), pathname: "/static/**" }];
  } catch {
    return [];
  }
}

/** Đường riêng tư (giỏ, thanh toán, đơn, API giỏ/checkout): không bao giờ cache dùng chung (S-505, đặc tả §7.4). */
export const PRIVATE_SOURCES = [
  "/gio-hang",
  "/thanh-toan",
  "/thanh-toan/:path*",
  "/don-hang/:path*",
  "/tra-cuu-don",
  "/tra-cuu-don/:path*",
  "/api/cart/:path*",
  "/api/checkout/:path*",
] as const;

/** Đường mang token/tham số thanh toán trên URL: không bao giờ gửi Referer. */
export const NO_REFERRER_SOURCES = ["/tra-cuu-don/xac-thuc", "/thanh-toan/ket-qua"] as const;

/** Service worker và manifest: luôn kiểm tra lại với server để bản mới đến được khách (không cache dài hạn tệp SW). */
export const SW_SOURCES = ["/sw.js", "/manifest.webmanifest"] as const;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [360, 414, 640, 768, 1024, 1280, 1440, 1920],
    imageSizes: [96, 160, 240, 320, 480],
    remotePatterns: backendImagePatterns(),
    // Dev: backend ở localhost (IP riêng) — chỉ bật ngoài production để bộ chặn SSRF của Next vẫn nguyên ở production.
    dangerouslyAllowLocalIP: process.env.NODE_ENV !== "production",
    // Ảnh demo của backend là SVG: cho phép nhưng ép tải xuống + CSP chặn script (khuyến nghị của Next).
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  async headers() {
    return [
      ...PRIVATE_SOURCES.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      })),
      ...SW_SOURCES.map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          ...(source === "/sw.js"
            ? [
                { key: "Service-Worker-Allowed", value: "/" },
                { key: "Content-Type", value: "text/javascript; charset=utf-8" },
              ]
            : []),
        ],
      })),
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      // Sau quy tắc chung (cùng khóa → quy tắc sau thắng): trang có token tra cứu trên URL và trang trở về từ cổng thanh
      // toán không gửi Referer ra ngoài (POST01, AT24).
      ...NO_REFERRER_SOURCES.map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
    ];
  },
};

export default nextConfig;
