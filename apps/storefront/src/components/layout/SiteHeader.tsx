import Link from "next/link";
import { CartBadge } from "../cart/CartBadge";
import { CartIcon, SearchIcon } from "./icons";
import styles from "./Header.module.css";
import { MobileMenu } from "./MobileMenu";
import { NavLinks, type NavItem } from "./NavLinks";

export interface SiteHeaderProps {
  categories: readonly NavItem[];
  /** Số ban đầu khi dựng; số thật do `CartBadge` lấy từ `/api/cart/count` sau khi tải. */
  cartCount?: number;
}

export function SiteHeader({ categories, cartCount = 0 }: SiteHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <MobileMenu items={categories} />
        <Link className={styles.brand} href="/">
          X-SHOP
        </Link>
        {categories.length > 0 ? (
          <nav aria-label="Danh mục" className={styles.desktopNav}>
            <NavLinks items={categories} />
          </nav>
        ) : null}
        <div className={styles.actions}>
          <Link href="/tim-kiem" prefetch={false} className={styles.iconLink}>
            <SearchIcon />
            <span className="visually-hidden">Tìm kiếm</span>
          </Link>
          <Link href="/gio-hang" prefetch={false} className={styles.iconLink}>
            <CartIcon />
            <CartBadge initial={cartCount} className={styles.count} />
          </Link>
        </div>
      </div>
    </header>
  );
}
