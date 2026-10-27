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

// Mọi lượng từ có trần (độ dài RFC 5321): `[^\s@]+` mở là bậc hai trên chuỗi dài không có `@` (T-136, validateEvent quét thân request).
const EMAIL_RE = /[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}/;
const PHONE_RE = /(?:\+?84|0)\d{8,10}$/;
/** SĐT VN nằm trong văn bản ("gọi 0912 345 678", "+84.912.345.678") — cùng mẫu với bộ che log backend (T-090). */
// Không dùng lookbehind (bundle client): biên trái bằng nhóm `(?:^|…)` — chỉ cần `test()`.
const PHONE_IN_TEXT_RE = /(?:^|[^\p{L}\p{N}+.])(?:\+84|84|0)(?![.])(?:[ .-]?\d){9,10}(?!\p{N})/u;
/** CCCD 12 số (mã tỉnh 001–096 → luôn bắt đầu bằng 0), liền hoặc tách nhóm 3. */
const CCCD_RE = /(?:^|[^\p{L}\p{N}])0\d{2}(?:[ .-]?\d{3}){3}(?![\p{L}\p{N}])/u;
/**
 * CMND 9 số chỉ nhận khi có từ khóa đi kèm (D-066, cùng luật `redact.ts` backend): 9 chữ số trần trùng số tiền VND.
 * Khoảng giữa từ khóa và số ≤ 16 ký tự không chứa chữ số/xuống dòng ("CMND số", "chứng minh nhân dân số").
 */
const CMND_RE =
  /(?:^|[^\p{L}\p{N}])(?:cmnd|cmtnd|cmt|chứng minh(?: nhân dân| thư)?|chung minh(?: nhan dan| thu)?)[^\d\n]{0,16}\d{3}[ .-]?\d{3}[ .-]?\d{3}(?!\d)/iu;
/** Từ khóa địa chỉ VN (không dấu và có dấu) và dạng số nhà `12/3`, `số 5`. */
const ADDRESS_RE =
  /(?:^|[\s,])(?:số|so|đường|duong|phố|pho|ngõ|ngo|ngách|ngach|hẻm|hem|phường|phuong|quận|quan|huyện|huyen|xã|tỉnh|tinh|thành phố|tp\.?)(?=[\s\d.,]|$)|\d{1,9}\/\d{1,9}|\d{1,9}\s{0,8}[,]\s{0,8}\p{L}/iu;

/** Viết tắt hành chính có tên/số theo sau: `P. Bến Thành`, `Q.1`, `TP.HCM`, `H. Củ Chi`, `TX. Sơn Tây` (phân biệt hoa). */
const ADDRESS_ABBR_RE = /(?:^|[\s,(])(?:P|Q|H|TX|TP|Tp)\.\s?(?:\p{Lu}|\d)/u;
/** Số nhà + tên riêng viết hoa có dấu cách (`12 Nguyễn Trãi`) — định danh hợp lệ không có dấu cách (ID_RE). */
const HOUSE_NAME_RE = /(?:^|[\s,(])\d+[a-zA-Z]?\s+\p{Lu}\p{Ll}/u;

/** `true` nếu chuỗi giống email, số điện thoại, CCCD/CMND hoặc địa chỉ (T-090: thêm CCCD + SĐT lẫn trong văn bản; T-136: CMND theo từ khóa). */
export function looksLikePii(raw: string): boolean {
  // NFC (D-112): chữ có dấu dạng tách (NFD) không được làm mẫu địa chỉ/từ khóa trượt.
  const s = raw.normalize("NFC");
  if (EMAIL_RE.test(s)) return true;
  const compact = s.replace(/[\s.()-]/g, "");
  if (PHONE_RE.test(compact) && /^\+?\d+$/.test(compact)) return true;
  if (CCCD_RE.test(s) || CMND_RE.test(s) || PHONE_IN_TEXT_RE.test(s)) return true;
  return ADDRESS_RE.test(s) || ADDRESS_ABBR_RE.test(s) || HOUSE_NAME_RE.test(s);
}

/** Quét mọi chuỗi (giá trị VÀ khóa) trong cấu trúc bất kỳ; trả đường dẫn đầu tiên giống PII, hoặc `null`. */
export function findPii(value: unknown, path = "$", depth = 0): string | null {
  if (depth > 8) return path;
  if (typeof value === "string") return looksLikePii(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPii(value[i], `${path}[${i}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (looksLikePii(k)) return `${path}.${k}`;
      const hit = findPii(v, `${path}.${k}`, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}
