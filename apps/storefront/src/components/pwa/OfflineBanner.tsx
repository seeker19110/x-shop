"use client";

import { useSyncExternalStore } from "react";
import styles from "./OfflineBanner.module.css";

function subscribe(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

/** Khi mất mạng: báo dữ liệu có thể đã cũ và không đặt hàng/thanh toán được (S-507). Render server: không hiện. */
export function OfflineBanner() {
  const offline = useSyncExternalStore(
    subscribe,
    () => !navigator.onLine,
    () => false,
  );
  if (!offline) return null;
  return (
    <div role="status" className={styles.banner}>
      Bạn đang ngoại tuyến — dữ liệu có thể đã cũ. Chưa thể đặt hàng hoặc thanh toán cho đến khi có mạng.
    </div>
  );
}
