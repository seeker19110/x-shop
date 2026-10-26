"use client";

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import styles from "./Dialog.module.css";
import { cx } from "./cx";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Trả focus về đây khi đóng; mặc định phần tử đang focus lúc mở. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  /** Kiểu hiển thị (Drawer dùng "drawer-right" / "drawer-bottom"). */
  variant?: "dialog" | "drawer-right" | "drawer-bottom";
}

const noopSubscribe = () => () => {};

let scrollLocks = 0;
let savedOverflow = "";

function lockScroll() {
  if (scrollLocks++ === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function unlockScroll() {
  if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** Lớp phủ modal tự quản lý: khóa focus, Esc đóng, khóa cuộn nền, trả focus. */
export function Overlay({
  open,
  onClose,
  title,
  children,
  returnFocusRef,
  closeLabel = "Đóng",
  variant = "dialog",
}: OverlayProps) {
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const returnRef = useRef(returnFocusRef);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
    returnRef.current = returnFocusRef;
  });

  const active = open && mounted;
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockScroll();
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(panel)[0] ?? panel;
      first.focus();
    }
    // Focus không được thoát ra ngoài lớp mở (vd. bằng chuột/trình đọc).
    const onFocusIn = (e: FocusEvent) => {
      const p = panelRef.current;
      if (p && e.target instanceof Node && !p.contains(e.target)) {
        (focusables(p)[0] ?? p).focus();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      unlockScroll();
      const target = returnRef.current?.current ?? opener;
      if (target?.isConnected === true) target.focus();
    };
  }, [active]);

  if (!active) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusables(panel);
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          styles.panel,
          styles[variant === "dialog" ? "dialog" : variant === "drawer-right" ? "right" : "bottom"],
        )}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label={closeLabel}
            onClick={() => onCloseRef.current()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export type DialogProps = Omit<OverlayProps, "variant">;

/** Hộp thoại modal ở giữa màn hình. */
export function Dialog(props: DialogProps) {
  return <Overlay {...props} variant="dialog" />;
}
