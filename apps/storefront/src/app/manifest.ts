import type { MetadataRoute } from "next";

/** Giá trị màu khớp token `--background` / `--accent` ở src/styles/tokens.css (test pwa kiểm khớp). */
export const MANIFEST_BACKGROUND = "#faf8f4";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "X-Shop — Thời trang Việt Nam",
    short_name: "X-Shop",
    description: "Cửa hàng thời trang X-Shop: mua nhanh trên điện thoại, không cần tài khoản.",
    lang: "vi",
    dir: "ltr",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: MANIFEST_BACKGROUND,
    theme_color: MANIFEST_BACKGROUND, // trùng `viewport.themeColor` ở layout
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
