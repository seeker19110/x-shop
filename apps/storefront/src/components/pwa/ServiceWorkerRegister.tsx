"use client";

import { useEffect } from "react";

/**
 * Đăng ký `/sw.js` sau khi trang tải xong (không chặn render). Chỉ ở production: dev không cần cache và dễ gây khó hiểu.
 * Lỗi đăng ký không ảnh hưởng trang (PWA chỉ là cải tiến).
 */
export function registerServiceWorker(
  nav: Pick<Navigator, "serviceWorker"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): Promise<unknown> {
  // Kiểu nói luôn có, nhưng trình duyệt (ngữ cảnh không an toàn, chế độ riêng tư) có thể để undefined.
  if (!nav || !("serviceWorker" in nav) || nav.serviceWorker == null) return Promise.resolve(null);
  return nav.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => null);
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const run = () => void registerServiceWorker();
    if (document.readyState === "complete") run();
    else {
      window.addEventListener("load", run, { once: true });
      return () => window.removeEventListener("load", run);
    }
  }, []);
  return null;
}
