import type { CatalogFilter } from "@x-shop/domain";
import type { Facets } from "../../lib/catalog/types";
import { Button } from "../ui/Button";
import { FilterFields } from "./FilterFields";
import styles from "./Filters.module.css";
import { t } from "../../lib/i18n";
import { safeHref } from "../../lib/safe-url";

/** Bộ lọc desktop: `<form method="get">` thuần — hoạt động không cần JS; URL là nguồn sự thật. */
export function FilterSidebar({
  basePath,
  filter,
  facets,
}: {
  basePath: string;
  filter: CatalogFilter;
  facets: Facets | null;
}) {
  return (
    <aside className={styles.sidebar} aria-labelledby="bo-loc-tieu-de">
      <form method="get" action={safeHref(basePath)} className={styles.sidebarForm}>
        <h2 id="bo-loc-tieu-de" className="visually-hidden">
          {t("catalog.filters.title")}
        </h2>
        {filter.q !== null ? <input type="hidden" name="q" value={filter.q} /> : null}
        {filter.sort !== "newest" ? <input type="hidden" name="sort" value={filter.sort} /> : null}
        <FilterFields idPrefix="sb" facets={facets} value={filter} />
        <Button type="submit" variant="secondary" className={styles.apply}>
          {t("catalog.filters.apply")}
        </Button>
      </form>
    </aside>
  );
}
