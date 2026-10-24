import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata: Metadata = {
  title: { default: "X-Shop", template: "%s | X-Shop" },
  description: "Cửa hàng thời trang X-Shop.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#faf8f4",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <body>
        <a className="skip-link" href="#noi-dung">
          Bỏ qua tới nội dung
        </a>
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.inner}>
              <Link className={styles.brand} href="/">
                X-SHOP
              </Link>
            </div>
          </header>
          <main id="noi-dung" tabIndex={-1} className={styles.main}>
            {children}
          </main>
          <footer className={styles.footer}>
            <div className={styles.inner}>
              <small>© X-Shop</small>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
