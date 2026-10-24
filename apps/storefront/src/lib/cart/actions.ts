"use server";

import { revalidatePath } from "next/cache";
import * as cart from "./service";
import type { CartActionResult } from "./types";

/**
 * Server Actions của giỏ — mỏng: mọi kiểm tra và gọi Medusa nằm ở `service.ts` (có test). Chỉ export hàm async
 * (ràng buộc của "use server"). Sau khi ghi thành công, trang giỏ/thanh toán được dựng lại với dữ liệu từ server.
 */

export interface AddToCartInput {
  /** Handle sản phẩm: server dùng để kiểm biến thể bằng dữ liệu catalog hiện hành. */
  handle: string;
  variantId: string;
  quantity: number;
}

async function done(r: CartActionResult): Promise<CartActionResult> {
  if (r.ok) {
    revalidatePath("/gio-hang");
    revalidatePath("/thanh-toan");
  }
  return r;
}

export async function addToCart(input: AddToCartInput): Promise<CartActionResult> {
  return done(await cart.addItem(input));
}

export async function updateLineQuantity(lineId: string, quantity: number): Promise<CartActionResult> {
  return done(await cart.setQuantity(lineId, quantity));
}

export async function removeCartLine(lineId: string): Promise<CartActionResult> {
  return done(await cart.removeLine(lineId));
}

export async function changeLineVariant(lineId: string, variantId: string): Promise<CartActionResult> {
  return done(await cart.changeVariant(lineId, variantId));
}

export async function refreshCartLine(lineId: string): Promise<CartActionResult> {
  return done(await cart.refreshLinePrice(lineId));
}

/** Gọi sau khi đặt đơn thành công: bỏ cookie giỏ để lần mua sau dùng giỏ mới. */
export async function forgetCart(): Promise<void> {
  await cart.forgetCart();
  revalidatePath("/gio-hang");
}
