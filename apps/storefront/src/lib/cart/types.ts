/** Kiểu của giỏ hàng phía storefront (không phụ thuộc Medusa; `view.ts` ánh xạ phản hồi Store API sang đây). */

/** Giới hạn khớp SPEC-checkout §3 (quantity ≤ 99/dòng, ≤ 50 dòng) — backend vẫn là nơi quyết định cuối. */
export const MAX_LINE_QUANTITY = 99;
export const MAX_LINES = 50;

export type LineIssueCode = "UNAVAILABLE" | "VARIANT_GONE" | "OUT_OF_STOCK" | "PRICE_CHANGED";

export interface LineIssue {
  code: LineIssueCode;
  message: string;
}

export interface VariantChoice {
  id: string;
  color: string;
  size: string;
  inStock: boolean;
}

/** Dữ liệu cho bộ chọn màu/size của một dòng (từ chi tiết sản phẩm hiện hành). */
export interface LineChoices {
  colors: { value: string; label: string }[];
  sizes: { value: string; label: string }[];
  variants: VariantChoice[];
  color: string | null;
  size: string | null;
}

export interface CartLineView {
  id: string;
  variantId: string | null;
  handle: string | null;
  title: string;
  /** "Đen / M" */
  variantLabel: string | null;
  thumbnail: { url: string; alt: string } | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  issue: LineIssue | null;
  choices: LineChoices | null;
}

/**
 * Dữ liệu giỏ cho trang giỏ/thanh toán — được tuần tự hoá sang Client Component nên KHÔNG chứa id giỏ: id giỏ là bearer
 * (ai có nó thao tác được giỏ qua Store API), chỉ nằm trong cookie HttpOnly và ở server.
 */
export interface CartView {
  lines: CartLineView[];
  /** Tổng số lượng (hiển thị ở header). */
  itemCount: number;
  /** Tạm tính do server trả (VND nguyên). */
  subtotal: number;
  /** true: có dòng lỗi chưa xử lý → không cho sang thanh toán (CHK01). */
  blocked: boolean;
}

export const EMPTY_CART_VIEW: CartView = { lines: [], itemCount: 0, subtotal: 0, blocked: false };

export type CartErrorCode =
  | "CART_DISABLED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "OUT_OF_STOCK"
  | "LIMIT"
  | "UNAVAILABLE"
  /** Ghi giỏ hết hạn chờ và đọc lại cũng lỗi: không biết đã ghi hay chưa — người dùng cần kiểm giỏ. */
  | "CART_UNKNOWN";

export type CartActionResult =
  { ok: true; count: number; message: string } | { ok: false; code: CartErrorCode; message: string };
