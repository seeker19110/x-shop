import Link from "next/link";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import styles from "./Button.module.css";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "md" | "lg";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Đang xử lý: aria-busy, không kích hoạt lại, vẫn giữ focus. */
  loading?: boolean;
  /** Chữ báo cho trình đọc khi loading. */
  loadingLabel?: string;
  fullWidth?: boolean;
  children: ReactNode;
}

type ButtonOnly = CommonProps &
  Omit<ComponentPropsWithRef<"button">, keyof CommonProps> & { href?: undefined };
type LinkOnly = CommonProps & Omit<ComponentPropsWithRef<"a">, keyof CommonProps | "href"> & { href: string };

export type ButtonProps = ButtonOnly | LinkOnly;

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    loading = false,
    loadingLabel = "Đang xử lý",
    fullWidth = false,
    children,
    className,
    ...rest
  } = props;
  const cls = cx(styles.button, styles[variant], styles[size], fullWidth && styles.full, className);
  const inner = (
    <>
      <span className={cx(styles.label, loading && styles.labelLoading)}>{children}</span>
      {loading ? (
        <>
          <span className={styles.spinner} aria-hidden="true" />
          <VisuallyHidden>{loadingLabel}</VisuallyHidden>
        </>
      ) : null}
    </>
  );

  if (props.href !== undefined) {
    const { href, onClick, ...anchor } = rest as Omit<ComponentPropsWithRef<"a">, "href"> & { href: string };
    const inert = loading || anchor["aria-disabled"] === true || anchor["aria-disabled"] === "true";
    return (
      <Link
        {...anchor}
        href={href}
        className={cls}
        aria-busy={loading || undefined}
        aria-disabled={inert || undefined}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          if (inert) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
      >
        {inner}
      </Link>
    );
  }

  const { onClick, disabled, type = "button", ...btn } = rest as ComponentPropsWithRef<"button">;
  return (
    <button
      {...btn}
      type={type}
      className={cls}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {inner}
    </button>
  );
}
