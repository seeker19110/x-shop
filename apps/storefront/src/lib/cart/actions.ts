"use server";

/**
 * Server action THÊM VÀO GIỎ — stub cho tới T-019 (giỏ thật: cookie HttpOnly `xs_cart`, Medusa Store API).
 * Hiện luôn trả lỗi rõ "chưa bật" để PDP hiển thị trạng thái lỗi đúng, không giả vờ thêm thành công.
 * Biên đã kiểm ngay từ bây giờ để T-019 chỉ thay phần thân.
 */
export interface AddToCartInput {
  variantId: string;
  quantity: number;
}

export type AddToCartResult =
  { ok: true } | { ok: false; code: "CART_DISABLED" | "INVALID_INPUT"; message: string };

export async function addToCart(input: AddToCartInput): Promise<AddToCartResult> {
  const validId = typeof input?.variantId === "string" && /^[\w-]{1,128}$/.test(input.variantId);
  const validQty = Number.isInteger(input?.quantity) && input.quantity >= 1 && input.quantity <= 10;
  if (!validId || !validQty) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Lựa chọn không hợp lệ. Vui lòng chọn lại màu và size.",
    };
  }
  return { ok: false, code: "CART_DISABLED", message: "Giỏ hàng chưa được bật. Vui lòng quay lại sau." };
}
