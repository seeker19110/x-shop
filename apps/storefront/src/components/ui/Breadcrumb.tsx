import Link from "next/link";
import styles from "./Breadcrumb.module.css";
import { isNonEmpty } from "../../lib/presence";
import { safeHref } from "../../lib/safe-url";
import { t } from "../../lib/i18n";

export interface BreadcrumbItem {
  label: string;
  /** Bỏ trống ở mục cuối (trang hiện tại). */
  href?: string;
}

export function Breadcrumb({
  items,
  label = t("ui.breadcrumb.label"),
}: {
  items: readonly BreadcrumbItem[];
  label?: string;
}) {
  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav aria-label={label} className={styles.nav}>
      <ol className={styles.list}>
        {items.map((item, i) => (
          <li key={`${i}-${item.label}`} className={styles.item}>
            {i === last || !isNonEmpty(item.href) ? (
              <span aria-current={i === last ? "page" : undefined}>{item.label}</span>
            ) : (
              <Link href={safeHref(item.href)} className={styles.link}>
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
