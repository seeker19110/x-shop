import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { OfflineBanner } from "../components/pwa/OfflineBanner";
import { ServiceWorkerRegister } from "../components/pwa/ServiceWorkerRegister";
import { SiteFooter } from "../components/layout/SiteFooter";
import { SiteHeader } from "../components/layout/SiteHeader";
import { getMenuCategories } from "../lib/catalog/client";
import { getClientEnv } from "../lib/env";
import "./globals.css";
import styles from "./layout.module.css";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getClientEnv().NEXT_PUBLIC_SITE_URL),
    title: { default: "X-Shop", template: "%s | X-Shop" },
    description: "Cửa hàng thời trang X-Shop.",
    openGraph: { type: "website", siteName: "X-Shop", locale: "vi_VN" },
    icons: { icon: "/icons/icon.svg", apple: "/icons/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#faf8f4",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // CSP nonce mỗi request (src/proxy.ts) chỉ gắn được khi trang render lúc request — mọi trang dưới layout này động
  // (dữ liệu catalog vẫn cache 60 giây ở tầng fetch). Trang tĩnh sẽ mang script không nonce → bị CSP chặn.
  await connection();
  // Menu lấy từ dữ liệu (chỉ nhóm có sản phẩm); lỗi nguồn → danh sách rỗng, không làm hỏng trang.
  const categories = await getMenuCategories();
  return (
    <html lang="vi">
      <body>
        <a className="skip-link" href="#noi-dung">
          Bỏ qua tới nội dung
        </a>
        <OfflineBanner />
        <ServiceWorkerRegister />
        <div className={styles.shell}>
          <SiteHeader categories={categories} />
          <main id="noi-dung" tabIndex={-1} className={styles.main}>
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
