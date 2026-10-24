import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";
import { cx } from "./cx";

export interface SkeletonProps {
  width?: string;
  height?: string;
  /** Tỷ lệ khung, vd "4 / 5" — giữ chỗ để tránh CLS. */
  aspectRatio?: string;
  rounded?: boolean;
  className?: string;
}

/** Khối giữ chỗ; ẩn khỏi trình đọc (vùng cha nên đặt aria-busy). */
export function Skeleton({ width, height, aspectRatio, rounded = false, className }: SkeletonProps) {
  const style: CSSProperties = { width, height, aspectRatio };
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, rounded && styles.rounded, className)}
      style={style}
    />
  );
}
