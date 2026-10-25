/**
 * Schema sự kiện telemetry (đặc tả §13.1, S-508). Chỉ kiểu + hằng + bộ quét PII thuần TypeScript — import được từ
 * client mà không kéo thư viện nào (zod chỉ ở `validate.ts`, phía server). Không PII: chỉ `item_id` (handle sản phẩm),
 * `sku`, mã đơn hiển thị, tiền số nguyên VND.
 */

export const SCHEMA_VERSION = 1 as const;

export const EVENT_NAMES = [
  "view_item_list",
  "select_item",
  "view_item",
  "select_variant",
  "view_size_guide",
  "add_to_cart",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "order_placed",
  "purchase",
  "refund",
] as const;

export type AnalyticsEventName = (typeof EVENT_NAMES)[number];

/** Sự kiện bắt buộc có `order_id` và `value` (tiền). */
export const ORDER_EVENTS: readonly AnalyticsEventName[] = ["order_placed", "purchase", "refund"];

export const MAX_ITEMS = 50;
export const PAYMENT_TYPES = ["cod", "vnpay"] as const;

/** Định danh: chữ/số/`_.:-`, 1–64 ký tự, không khoảng trắng — không chỗ cho email, địa chỉ, họ tên. */
export const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,63}$/u;

export interface AnalyticsItem {
  item_id: string;
  sku?: string;
  quantity?: number;
  /** Đơn giá, số nguyên VND. */
  price?: number;
}

/** Phần người gọi `track()` cung cấp. */
export interface AnalyticsPayload {
  event: AnalyticsEventName;
  /** Số nguyên VND ≥ 0. */
  value?: number;
  items?: AnalyticsItem[];
  order_id?: string;
  list_id?: string;
  index?: number;
  payment_type?: (typeof PAYMENT_TYPES)[number];
}

export interface AnalyticsEvent extends AnalyticsPayload {
  v: typeof SCHEMA_VERSION;
  currency: "VND";
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:\+?84|0)\d{8,10}$/;
/** Từ khóa địa chỉ VN (không dấu và có dấu) và dạng số nhà `12/3`, `số 5`. */
const ADDRESS_RE =
  /(?:^|[\s,])(?:số|so|đường|duong|phố|pho|ngõ|ngo|ngách|ngach|hẻm|hem|phường|phuong|quận|quan|huyện|huyen|xã|tỉnh|tinh|thành phố|tp\.?)(?=[\s\d.,]|$)|\d+\/\d+|\d+\s*[,]\s*\p{L}/iu;

/** `true` nếu chuỗi giống email, số điện thoại hoặc địa chỉ. */
export function looksLikePii(s: string): boolean {
  if (EMAIL_RE.test(s)) return true;
  const compact = s.replace(/[\s.()-]/g, "");
  if (PHONE_RE.test(compact) && /^\+?\d+$/.test(compact)) return true;
  return ADDRESS_RE.test(s);
}

/** Quét mọi chuỗi (giá trị VÀ khóa) trong cấu trúc bất kỳ; trả đường dẫn đầu tiên giống PII, hoặc `null`. */
export function findPii(value: unknown, path = "$", depth = 0): string | null {
  if (depth > 8) return path;
  if (typeof value === "string") return looksLikePii(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPii(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (looksLikePii(k)) return `${path}.${k}`;
      const hit = findPii(v, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
