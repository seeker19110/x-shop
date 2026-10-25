import { SORTS, serializeFilter, type CatalogFilter, type Sort } from "@x-shop/domain";
import styles from "./CatalogView.module.css";

const SORT_LABEL: Record<Sort, string> = {
  newest: "Mới nhất",
  price_asc: "Giá tăng dần",
  price_desc: "Giá giảm dần",
};

/** Sắp xếp bằng `<form method="get">`: chạy không cần JS; giữ nguyên các điều kiện lọc bằng input ẩn, về trang 1. */
export function SortForm({ basePath, filter }: { basePath: string; filter: CatalogFilter }) {
  const rest = new URLSearchParams(serializeFilter({ ...filter, sort: "newest", page: 1 }));
  return (
    <form method="get" action={basePath} className={styles.sortForm}>
      {[...rest].map(([k, v]) => (
        <input key={`${k}=${v}`} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor="sap-xep" className={styles.sortLabel}>
        Sắp xếp
      </label>
      <select id="sap-xep" name="sort" defaultValue={filter.sort} className={styles.select}>
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {SORT_LABEL[s]}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.sortApply}>
        Áp dụng
      </button>
    </form>
  );
}
