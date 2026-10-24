"use client";

import styles from "./Chip.module.css";

export interface ChipProps {
  label: string;
  onRemove: () => void;
  /** Tiền tố của aria-label nút gỡ. */
  removeLabelPrefix?: string;
}

/** Bộ lọc đang áp; nút gỡ có tên "Bỏ lọc: <nhãn>". */
export function Chip({ label, onRemove, removeLabelPrefix = "Bỏ lọc" }: ChipProps) {
  return (
    <span className={styles.chip}>
      <span className={styles.text}>{label}</span>
      <button
        type="button"
        className={styles.remove}
        aria-label={`${removeLabelPrefix}: ${label}`}
        onClick={onRemove}
      >
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}

export interface ChipListItem {
  key: string;
  label: string;
}

export interface ChipListProps {
  items: readonly ChipListItem[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
  label?: string;
}

export function ChipList({ items, onRemove, onClearAll, label = "Bộ lọc đang áp" }: ChipListProps) {
  if (items.length === 0) return null;
  return (
    <div className={styles.listWrap}>
      <ul className={styles.list} aria-label={label}>
        {items.map((it) => (
          <li key={it.key}>
            <Chip label={it.label} onRemove={() => onRemove(it.key)} />
          </li>
        ))}
      </ul>
      <button type="button" className={styles.clear} onClick={onClearAll}>
        Xóa tất cả
      </button>
    </div>
  );
}
