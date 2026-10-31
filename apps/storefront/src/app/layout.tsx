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
import { t } from "../lib/i18n";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(getClientEnv().NEXT_PUBLIC_SITE_URL),
    title: { default: t("layout.siteName"), template: t("layout.titleTemplate") },
    description: t("layout.description"),
    openGraph: { type: "website", siteName: t("layout.siteName"), locale: "vi_VN" },
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
          {t("layout.skipToContent")}
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
