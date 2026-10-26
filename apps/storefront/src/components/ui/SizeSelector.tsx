"use client";

import Link from "next/link";
import { useId } from "react";
import { InlineError } from "./InlineError";
import styles from "./SizeSelector.module.css";
import { cx } from "./cx";
import { isNonEmpty } from "../../lib/presence";

export interface SizeOption {
  value: string;
  label?: string;
  available: boolean;
}

export interface SizeSelectorProps {
  options: readonly SizeOption[];
  value: string | null;
  onChange: (value: string) => void;
  /** Hiện khi người dùng bấm mua mà chưa chọn size; gắn aria-describedby vào nhóm. */
  error?: string | null;
  /** Liên kết "Hướng dẫn chọn size" đặt cạnh nhãn. */
  sizeGuideHref?: string;
  /** Thay cho `sizeGuideHref` khi bảng size mở trong Dialog (nút, không điều hướng). */
  onSizeGuide?: () => void;
  legend?: string;
}

/** Nhóm button aria-pressed (S-502). Size hết hàng vẫn focus được nhưng không chọn được. */
export function SizeSelector({
  options,
  value,
  onChange,
  error,
  sizeGuideHref,
  onSizeGuide,
  legend = "Size",
}: SizeSelectorProps) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const errorId = `${uid}-error`;
  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span id={labelId} className={styles.legend}>
          {legend}
        </span>
        {onSizeGuide ? (
          <button type="button" className={styles.guide} onClick={onSizeGuide} aria-haspopup="dialog">
            Hướng dẫn chọn size
          </button>
        ) : isNonEmpty(sizeGuideHref) ? (
          <Link href={sizeGuideHref} className={styles.guide}>
            Hướng dẫn chọn size
          </Link>
        ) : null}
      </div>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={isNonEmpty(error) ? errorId : undefined}
        className={styles.group}
      >
        {options.map((o) => {
          const selected = o.available && o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={selected}
              aria-disabled={!o.available || undefined}
              className={cx(styles.size, selected && styles.selected, !o.available && styles.soldOut)}
              onClick={() => {
                if (o.available) onChange(o.value);
              }}
            >
              <span>{o.label ?? o.value}</span>
              {!o.available ? <span className={styles.note}>hết hàng</span> : null}
            </button>
          );
        })}
      </div>
      {isNonEmpty(error) ? <InlineError id={errorId}>{error}</InlineError> : null}
    </div>
  );
}
