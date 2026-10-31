"use client";

import { useSyncExternalStore } from "react";
import styles from "./OfflineBanner.module.css";
import { t } from "../../lib/i18n";

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
      {t("pwa.offlineBanner")}
    </div>
  );
}
