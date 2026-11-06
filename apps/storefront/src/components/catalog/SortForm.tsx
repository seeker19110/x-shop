import { SORTS, serializeFilter, type CatalogFilter, type Sort } from "@x-shop/domain";
import styles from "./CatalogView.module.css";
import { t, type MessageKey } from "../../lib/i18n";
import { safeHref } from "../../lib/safe-url";

const SORT_LABEL: Record<Sort, MessageKey> = {
  newest: "catalog.sort.newest",
  price_asc: "catalog.sort.priceAsc",
  price_desc: "catalog.sort.priceDesc",
};

/** Sắp xếp bằng `<form method="get">`: chạy không cần JS; giữ nguyên các điều kiện lọc bằng input ẩn, về trang 1. */
export function SortForm({ basePath, filter }: { basePath: string; filter: CatalogFilter }) {
  const rest = new URLSearchParams(serializeFilter({ ...filter, sort: "newest", page: 1 }));
  return (
    <form method="get" action={safeHref(basePath)} className={styles.sortForm}>
      {[...rest].map(([k, v]) => (
        <input key={`${k}=${v}`} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor="sap-xep" className={styles.sortLabel}>
        {t("catalog.sort.label")}
      </label>
      <select id="sap-xep" name="sort" defaultValue={filter.sort} className={styles.select}>
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {t(SORT_LABEL[s])}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.sortApply}>
        {t("catalog.sort.apply")}
      </button>
    </form>
  );
}
