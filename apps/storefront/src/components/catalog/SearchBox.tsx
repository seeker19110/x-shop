import { MAX_QUERY_LENGTH } from "@x-shop/domain";
import { Button } from "../ui/Button";
import styles from "./CatalogView.module.css";

/** Ô tìm kiếm `<form method="get">` — chạy không cần JS; có nhãn thật và `role="search"`. */
export function SearchBox({ defaultValue }: { defaultValue: string | null }) {
  return (
    <form role="search" method="get" action="/tim-kiem" className={styles.searchForm}>
      <label htmlFor="tu-khoa" className={styles.searchLabel}>
        Tìm theo tên, mã SKU hoặc danh mục
      </label>
      <div className={styles.searchRow}>
        <input
          id="tu-khoa"
          type="search"
          name="q"
          defaultValue={defaultValue ?? ""}
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          enterKeyHint="search"
          className={styles.searchInput}
        />
        <Button type="submit" size="lg">
          Tìm
        </Button>
      </div>
    </form>
  );
}
