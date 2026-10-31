"use client";

import { useId } from "react";
import styles from "./ColorSwatch.module.css";
import { cx } from "./cx";
import { isNonEmpty } from "../../lib/presence";

export interface SwatchOption {
  value: string;
  /** Tên màu: dùng cho tên truy cập và chữ hiện khi chọn. */
  name: string;
  /** Mã màu CSS dạng hex (dữ liệu màu sản phẩm từ catalog). */
  hex?: string;
  /** Ảnh swatch (ưu tiên hơn `hex`). Trang trí — tên màu đã có ở chữ. */
  imageUrl?: string;
  available?: boolean;
}

export interface ColorSwatchGroupProps {
  options: readonly SwatchOption[];
  value: string | null;
  onChange: (value: string) => void;
  legend?: string;
}

/** Nhóm swatch chọn màu: trạng thái chọn = viền dày + dấu ✓ (không chỉ màu). */
export function ColorSwatchGroup({ options, value, onChange, legend = "Màu" }: ColorSwatchGroupProps) {
  const uid = useId();
  const selected = options.find((o) => o.value === value);
  return (
    <div className={styles.root}>
      <p className={styles.head} id={`${uid}-label`}>
        <span className={styles.legend}>{legend}</span>
        {selected ? <span className={styles.selectedName}>: {selected.name}</span> : null}
      </p>
      <div role="group" aria-labelledby={`${uid}-label`} className={styles.group}>
        {options.map((o) => {
          const isSelected = o.value === value;
          const unavailable = o.available === false;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={isSelected}
              aria-label={unavailable ? `${o.name} (hết hàng)` : o.name}
              className={cx(styles.swatch, isSelected && styles.selected, unavailable && styles.unavailable)}
              onClick={() => onChange(o.value)}
            >
              <Swatch option={o} className={styles.fill} />
              {isSelected ? (
                <span aria-hidden="true" className={styles.tick}>
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Ô màu thuần hiển thị (không tương tác). */
export function Swatch({ option, className }: { option: SwatchOption; className?: string }) {
  const style = isNonEmpty(option.imageUrl)
    ? { backgroundImage: `url("${option.imageUrl.replace(/["\\\n]/g, "")}")` }
    : { backgroundColor: option.hex ?? "transparent" };
  return <span aria-hidden="true" className={cx(styles.dot, className)} style={style} />;
}
