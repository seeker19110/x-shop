"use client";

import type { RefObject } from "react";
import { Button } from "../ui/Button";
import styles from "./Product.module.css";
import { useStickyVisible } from "./sticky";

/**
 * CTA dính đáy trên mobile (S-503): chỉ hiện khi khối mua chính ra khỏi viewport và không có ô nhập đang focus;
 * chừa `env(safe-area-inset-bottom)`. Ẩn → không có trong DOM (không chiếm focus/trình đọc).
 */
export function StickyCta({
  target,
  label,
  priceLabel,
  disabled,
  loading,
  onClick,
}: {
  target: RefObject<Element | null>;
  label: string;
  priceLabel: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const visible = useStickyVisible(target);
  if (!visible) return null;
  return (
    <div className={styles.sticky} role="region" aria-label="Mua nhanh">
      <span className={styles.stickyPrice}>{priceLabel}</span>
      <Button
        size="lg"
        loading={loading}
        disabled={disabled}
        onClick={onClick}
        className={styles.stickyButton}
      >
        {label}
      </Button>
    </div>
  );
}
