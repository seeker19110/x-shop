import type { ComponentPropsWithRef, ReactNode } from "react";
import styles from "./IconButton.module.css";
import { cx } from "./cx";

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "aria-label" | "children"> {
  /** Bắt buộc: tên truy cập của nút chỉ có biểu tượng. */
  label: string;
  /** Biểu tượng (được ẩn khỏi trình đọc). */
  icon: ReactNode;
}

export function IconButton({ label, icon, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} aria-label={label} className={cx(styles.iconButton, className)}>
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
    </button>
  );
}
