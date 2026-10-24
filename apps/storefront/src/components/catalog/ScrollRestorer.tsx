"use client";

import { useEffect } from "react";
import { loadScroll, saveScroll, scrollKeyOf } from "./scroll-restore";

/** Cờ "vừa Back/Forward": đặt bởi popstate (đi lại trong lịch sử) trước khi trang đích dựng lại. */
let traversed = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    traversed = true;
  });
}

function isHistoryReload(): boolean {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return false;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === "back_forward";
}

/**
 * Gắn vào trang danh sách/tìm kiếm: ghi `scrollY` theo URL khi cuộn và khôi phục khi quay lại bằng Back (CAT03).
 * Vào danh sách bằng liên kết thường → KHÔNG khôi phục (luôn từ đầu trang). Không render gì.
 */
export function ScrollRestorer() {
  useEffect(() => {
    const key = scrollKeyOf(window.location);
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      return; // bị chặn truy cập storage
    }
    const store = storage;

    if (traversed || isHistoryReload()) {
      const y = loadScroll(store, key);
      if (y !== null) {
        // Hai nhịp: sau khi bố cục ổn định (ảnh có tỷ lệ cố định nên thường đủ).
        requestAnimationFrame(() => {
          window.scrollTo(0, y);
          requestAnimationFrame(() => window.scrollTo(0, y));
        });
      }
    }
    traversed = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => saveScroll(store, key, window.scrollY);
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 120);
    };
    const onHide = () => {
      clearTimeout(timer);
      flush();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    // Ghi ngay khi bấm bất kỳ liên kết (vào PDP): không chờ nhịp throttle của sự kiện cuộn.
    document.addEventListener("click", flush, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("click", flush, true);
    };
  }, []);
  return null;
}
