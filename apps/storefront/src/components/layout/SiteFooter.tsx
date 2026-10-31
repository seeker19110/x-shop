import Link from "next/link";
import { POLICY_LINKS, SELLER } from "../../lib/content/site";
import styles from "./Footer.module.css";
import { safeHref } from "../../lib/safe-url";
import { t } from "../../lib/i18n";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <section aria-labelledby="chan-trang-don-vi-ban" className={styles.block}>
          <h2 id="chan-trang-don-vi-ban" className={styles.heading}>
            {t("footer.sellerHeading")}
          </h2>
          <address className={styles.address}>
            <span>{SELLER.name}</span>
            <span>{SELLER.address}</span>
            <span>{SELLER.taxCode}</span>
            <span>{SELLER.contact}</span>
          </address>
        </section>
        <nav aria-label={t("footer.policyNav")} className={styles.block}>
          <h2 className={styles.heading}>{t("footer.policyHeading")}</h2>
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
        <small className={styles.copy}>{t("footer.copyright")}</small>
      </div>
    </footer>
  );
}
