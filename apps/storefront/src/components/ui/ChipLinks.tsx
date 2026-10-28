import Link from "next/link";
import styles from "./Chip.module.css";
import { safeHref } from "../../lib/safe-url";

export interface ChipLinkItem {
  key: string;
  label: string;
  /** URL chuẩn KHÔNG còn điều kiện này. */
  href: string;
}

/**
 * Chip bộ lọc đang áp dạng LIÊN KẾT (server-render, không cần JS): gỡ một chip = đi tới URL chuẩn không có giá trị đó.
 * Tên truy cập của nút gỡ: "Bỏ lọc: <nhãn>" (giống `Chip`).
 */
export function ChipLinks({
  items,
  clearAllHref,
  label = "Bộ lọc đang áp",
}: {
  items: readonly ChipLinkItem[];
  clearAllHref: string;
  label?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={styles.listWrap}>
      <ul className={styles.list} aria-label={label}>
        {items.map((it) => (
          <li key={it.key} className={styles.chip}>
            <span className={styles.text}>{it.label}</span>
            <Link
              href={safeHref(it.href)}
              prefetch={false}
              className={styles.remove}
              aria-label={`Bỏ lọc: ${it.label}`}
              scroll={false}
            >
              <span aria-hidden="true">×</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link href={safeHref(clearAllHref)} prefetch={false} className={styles.clear}>
        Xóa tất cả
      </Link>
    </div>
  );
}
