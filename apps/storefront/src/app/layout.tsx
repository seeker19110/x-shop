import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
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
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#faf8f4",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Menu lấy từ dữ liệu (chỉ nhóm có sản phẩm); lỗi nguồn → danh sách rỗng, không làm hỏng trang.
  const categories = await getMenuCategories();
  return (
    <html lang="vi">
      <body>
        <a className="skip-link" href="#noi-dung">
          Bỏ qua tới nội dung
        </a>
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
