import { findPii, ORDER_EVENTS, SCHEMA_VERSION, type AnalyticsEvent, type AnalyticsPayload } from "./schema";
import { getAnalyticsTransport } from "../env/public";
import { isNonEmpty } from "../presence";

/**
 * `track()` phía client — không thư viện ngoài. Mặc định đẩy vào `window.dataLayer`; khi cấu hình
 * `NEXT_PUBLIC_ANALYTICS_TRANSPORT=beacon` VÀ người dùng đã đồng ý (`setAnalyticsConsent(true)`) thì gửi
 * `navigator.sendBeacon("/api/analytics")`. Không bao giờ ném lỗi ra ngoài: telemetry hỏng không được làm hỏng mua hàng.
 */

export const ANALYTICS_ENDPOINT = "/api/analytics";
const CONSENT_KEY = "xs_analytics_consent";
const PURCHASE_KEY = "xs_purchase_";

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

const memoryPurchases = new Set<string>();
let memoryConsent = false;

/**
 * Kho dedupe `purchase`: localStorage (bền qua phiên trình duyệt — trang đơn mở lại nhiều ngày sau vẫn không bắn lại),
 * không có thì sessionStorage, cuối cùng là bộ nhớ.
 */
function storages(): Storage[] {
  if (typeof window === "undefined") return [];
  const out: Storage[] = [];
  for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
    try {
      const s = pick();
      // Kiểu nói luôn có; môi trường lạ có thể trả null.
      if (s != null) out.push(s);
    } catch {
      // trình duyệt chặn kho này
    }
  }
  return out;
}

export function setAnalyticsConsent(granted: boolean): void {
  memoryConsent = granted;
  try {
    if (granted) window.localStorage.setItem(CONSENT_KEY, "granted");
    else window.localStorage.removeItem(CONSENT_KEY);
  } catch {
    // trình duyệt chặn localStorage: giữ trong bộ nhớ của phiên trang
  }
}

export function hasAnalyticsConsent(): boolean {
  if (memoryConsent) return true;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

/**
 * `true` nếu đây là lần đầu thấy `order_id` trên trình duyệt này (và ghi nhận luôn). Khóa chỉ chứa mã đơn hiển thị,
 * không PII. Kho đầu tiên đọc/ghi được quyết định; kho hỏng → thử kho sau → bộ nhớ.
 */
function firstPurchase(orderId: string): boolean {
  const key = PURCHASE_KEY + orderId;
  for (const s of storages()) {
    try {
      if (s.getItem(key) !== null) return false;
      s.setItem(key, "1");
      return true;
    } catch {
      // kho này hỏng/đầy — thử kho tiếp theo
    }
  }
  if (memoryPurchases.has(key)) return false;
  memoryPurchases.add(key);
  return true;
}

/** Chỉ cho test. */
export function resetAnalyticsForTests(): void {
  memoryPurchases.clear();
  memoryConsent = false;
}

function validLocally(e: AnalyticsEvent): boolean {
  if (e.value !== undefined && (!Number.isInteger(e.value) || e.value < 0)) return false;
  if (
    (ORDER_EVENTS as readonly string[]).includes(e.event) &&
    (!isNonEmpty(e.order_id) || e.value === undefined)
  )
    return false;
  return findPii(e) === null;
}

/** Trả `true` nếu sự kiện đã được phát đi (false: bị bỏ do sai dữ liệu / trùng purchase). */
export function track(payload: AnalyticsPayload): boolean {
  try {
    if (typeof window === "undefined") return false;
    const event: AnalyticsEvent = { v: SCHEMA_VERSION, currency: "VND", ...payload };
    if (!validLocally(event)) return false;
    if (event.event === "purchase" && !firstPurchase(event.order_id as string)) return false;

    (window.dataLayer ??= []).push(event);
    if (getAnalyticsTransport() === "beacon" && hasAnalyticsConsent()) {
      navigator.sendBeacon?.(
        ANALYTICS_ENDPOINT,
        new Blob([JSON.stringify(event)], { type: "application/json" }),
      );
    }
    return true;
  } catch {
    return false;
  }
}
