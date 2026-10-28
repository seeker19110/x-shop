import Link from "next/link";
import { POLICY_LINKS, SELLER } from "../../lib/content/site";
import styles from "./Footer.module.css";
import { safeHref } from "../../lib/safe-url";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <section aria-labelledby="chan-trang-don-vi-ban" className={styles.block}>
          <h2 id="chan-trang-don-vi-ban" className={styles.heading}>
            Đơn vị bán hàng
          </h2>
          <address className={styles.address}>
            <span>{SELLER.name}</span>
            <span>{SELLER.address}</span>
            <span>{SELLER.taxCode}</span>
            <span>{SELLER.contact}</span>
          </address>
        </section>
        <nav aria-label="Chính sách" className={styles.block}>
          <h2 className={styles.heading}>Chính sách</h2>
          <ul className={styles.list}>
            {POLICY_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={safeHref(l.href)} className={styles.link}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <small className={styles.copy}>© X-Shop</small>
      </div>
    </footer>
  );
}
