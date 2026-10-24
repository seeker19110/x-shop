"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { categoryHref } from "../../lib/content/navigation";
import styles from "./Header.module.css";

export interface NavItem {
  handle: string;
  name: string;
}

/** Danh sách link danh mục; trang hiện tại có `aria-current="page"` + gạch chân (DESIGN.md §Menu). */
export function NavLinks({ items, onNavigate }: { items: readonly NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className={styles.navList}>
      {items.map((c) => {
        const href = categoryHref(c.handle);
        return (
          <li key={c.handle}>
            <Link
              href={href}
              prefetch={false}
              className={styles.navLink}
              aria-current={pathname === href ? "page" : undefined}
              onClick={onNavigate}
            >
              {c.name}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
