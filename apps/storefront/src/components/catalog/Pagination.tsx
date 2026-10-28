import type { CatalogFilter } from "@x-shop/domain";
import Link from "next/link";
import { hrefFor, pageWindow } from "./filter-state";
import styles from "./CatalogView.module.css";
import { safeHref } from "../../lib/safe-url";

/**
 * Phân trang bằng liên kết `<a href>` thật (crawl được, chạy không cần JS), có `rel="prev"` / `rel="next"`.
 * `prefetch={false}`: không prefetch hàng loạt trang trên mạng di động (đặc tả §10.2).
 */
export function Pagination({
  basePath,
  filter,
  lastPage,
}: {
  basePath: string;
  filter: CatalogFilter;
  lastPage: number;
}) {
  if (lastPage <= 1) return null;
  const to = (page: number) => hrefFor(basePath, { ...filter, page });
  const current = filter.page;
  return (
    <nav aria-label="Phân trang" className={styles.pagination}>
      <ul className={styles.pages}>
        {current > 1 ? (
          <li>
            <Link href={safeHref(to(current - 1))} rel="prev" prefetch={false} className={styles.pageLink}>
              Trang trước
            </Link>
          </li>
        ) : null}
        {pageWindow(current, lastPage).map((p, i) =>
          p === null ? (
            <li key={`gap-${i}`} aria-hidden="true" className={styles.gap}>
              …
            </li>
          ) : (
            <li key={p}>
              <Link
                href={safeHref(to(p))}
                prefetch={false}
                className={styles.pageLink}
                aria-current={p === current ? "page" : undefined}
                aria-label={`Trang ${p}`}
              >
                {p}
              </Link>
            </li>
          ),
        )}
        {current < lastPage ? (
          <li>
            <Link href={safeHref(to(current + 1))} rel="next" prefetch={false} className={styles.pageLink}>
              Trang sau
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
