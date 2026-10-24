import type { ReactNode } from "react";
import styles from "./InlineError.module.css";
import { cx } from "./cx";

export interface InlineErrorProps {
  children: ReactNode;
  id?: string;
  /** true: role="alert" (đọc ngay) — dùng khi lỗi xuất hiện sau thao tác; mặc định chỉ là văn bản gắn qua aria-describedby. */
  alert?: boolean;
  className?: string;
}

/** Lỗi luôn có chữ và biểu tượng, không chỉ màu (DESIGN.md). */
export function InlineError({ children, id, alert = false, className }: InlineErrorProps) {
  return (
    <p id={id} role={alert ? "alert" : undefined} className={cx(styles.error, className)}>
      <span aria-hidden="true" className={styles.icon}>
        !
      </span>
      <span>{children}</span>
    </p>
  );
}
