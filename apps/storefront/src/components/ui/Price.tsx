import { formatVnd } from "../../lib/format-vnd";
import styles from "./Price.module.css";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

export interface PriceProps {
  /** Giá hiện tại (hoặc giá thấp nhất khi có `max`), số nguyên VND. */
  current: number;
  /** Giá trước giảm; chỉ hiển thị khi lớn hơn giá hiện tại. */
  original?: number | null;
  /** Giá cao nhất của khoảng giá; chỉ hiển thị "Từ X" khi lớn hơn `current`. */
  max?: number | null;
  className?: string;
}

/** Phần trăm giảm làm tròn xuống; null khi không hợp lệ hoặc < 1%. */
export function discountPercent(current: number, original?: number | null): number | null {
  if (original == null || !(original > current) || current < 0) return null;
  const pct = Math.floor(((original - current) / original) * 100);
  return pct >= 1 ? pct : null;
}

/** Số tiền sai (không nguyên/âm) làm `formatVnd` ném lỗi — cố ý, không che dữ liệu hỏng. */
export function Price({ current, original, max, className }: PriceProps) {
  const isRange = max != null && max > current;
  if (isRange) {
    return (
      <span className={cx(styles.price, className)}>
        <span className={styles.current}>{`Từ ${formatVnd(current)}`}</span>
      </span>
    );
  }
  if (original != null && original > current) {
    return (
      <span className={cx(styles.price, className)}>
        <VisuallyHidden>{`Giá gốc ${formatVnd(original)}, giá hiện tại ${formatVnd(current)}`}</VisuallyHidden>
        <span aria-hidden="true" className={styles.current}>
          {formatVnd(current)}
        </span>
        <s aria-hidden="true" className={styles.original}>
          {formatVnd(original)}
        </s>
      </span>
    );
  }
  return (
    <span className={cx(styles.price, className)}>
      <span className={styles.current}>{formatVnd(current)}</span>
    </span>
  );
}
