/** Sự kiện trình duyệt báo số lượng giỏ đã đổi — header cập nhật mà không tải lại trang. Chỉ mang một con số, không PII. */
export const CART_CHANGED_EVENT = "xs:cart-changed";

export function emitCartChanged(count: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ count: number }>(CART_CHANGED_EVENT, { detail: { count } }));
}
