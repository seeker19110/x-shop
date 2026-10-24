"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./Toast.module.css";
import { cx } from "./cx";

/**
 * Vùng thông báo aria-live="polite": luôn có trong DOM, chỉ đổi nội dung;
 * không chuyển focus (dùng cho "Đã thêm vào giỏ", S-501).
 */
export function LiveRegion({
  message,
  className,
  visible = false,
}: {
  message: string;
  className?: string;
  /** false: chỉ trình đọc nghe thấy. */
  visible?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cx(!visible && "visually-hidden", className)}
    >
      {message}
    </div>
  );
}

interface ToastItem {
  id: number;
  message: string;
}

interface ToastApi {
  notify: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toast tự tắt sau `durationMs` (>= 6 giây theo WCAG 2.2.1) và có nút đóng; không lấy focus. */
export function ToastProvider({ children, durationMs = 6000 }: { children: ReactNode; durationMs?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback(
    (message: string) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-2), { id, message }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), durationMs),
      );
    },
    [dismiss, durationMs],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className={styles.region}>
        {items.map((t) => (
          <div key={t.id} className={styles.toast}>
            <span>{t.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              aria-label="Đóng thông báo"
              onClick={() => dismiss(t.id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast phải nằm trong <ToastProvider>");
  return ctx;
}
