"use client";

import styles from "./Chip.module.css";
import { t } from "../../lib/i18n";

export interface ChipProps {
  label: string;
  onRemove: () => void;
  /** Tiền tố của aria-label nút gỡ. */
  removeLabelPrefix?: string;
}

/** Bộ lọc đang áp; nút gỡ có tên "Bỏ lọc: <nhãn>". */
export function Chip({ label, onRemove, removeLabelPrefix }: ChipProps) {
  return (
    <span className={styles.chip}>
      <span className={styles.text}>{label}</span>
      <button
        type="button"
        className={styles.remove}
        aria-label={
          removeLabelPrefix === undefined
            ? t("catalog.removeFilter", { label })
            : `${removeLabelPrefix}: ${label}`
        }
        onClick={onRemove}
      >
        <span aria-hidden="true">{t("ui.glyph.close")}</span>
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

export function ChipList({ items, onRemove, onClearAll, label = t("ui.chip.listLabel") }: ChipListProps) {
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
        {t("ui.chip.clearAll")}
      </button>
    </div>
  );
}
