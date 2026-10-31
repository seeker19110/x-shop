import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  addAvailableVariantToCart,
  fillCheckout,
  openCartFromPdp,
  openCheckoutFromCart,
  openFirstProductFromHome,
  placeCodOrder,
} from "./helpers";

/** Đọc ô giá trị (dd) đứng ngay sau nhãn (dt) khớp đúng nhãn; trả số VND nguyên (bỏ dấu chấm, ký hiệu ₫, dấu trừ). */
async function readVnd(page: Page, label: string): Promise<number> {
  const dd = page.locator(`dt:text-is("${label}") + dd`).first();
  await expect(dd).toHaveText(/\d/);
  const digits = ((await dd.textContent()) ?? "").replace(/\D/g, "");
  const value = Number(digits);
  expect(Number.isSafeInteger(value), `${label}: "${digits}" không phải số nguyên VND an toàn`).toBe(true);
  return value;
}

/**
 * UX-CONTENT-006: giá và chi phí hiện đủ trước bước xác nhận — không có khoản mới xuất hiện ở bước cuối.
 * Giỏ (tiền hàng) = checkout (tiền hàng) và tổng ở checkout (bước đầu có đủ phí) = tổng ở trang đơn đã đặt.
 */
test.describe("UX-CONTENT-006 — tổng tiền nhất quán giữa các bước", () => {
  test("tạm tính giỏ = tiền hàng checkout; tổng phải trả ở checkout = tổng cộng ở trang đơn", async ({
    page,
    buyer,
  }) => {
    await openFirstProductFromHome(page);
    await addAvailableVariantToCart(page);
    await openCartFromPdp(page);
    const cartSubtotal = await readVnd(page, "Tạm tính");
    expect(cartSubtotal).toBeGreaterThan(0);

    await openCheckoutFromCart(page);
    await fillCheckout(page, "cod", buyer);
    const checkoutSubtotal = await readVnd(page, "Tiền hàng");
    const checkoutShipping = await readVnd(page, "Phí vận chuyển");
    const checkoutTotal = await readVnd(page, "Tổng phải trả");
    expect(checkoutSubtotal).toBe(cartSubtotal);
    // Không có khoản ẩn: khi chưa có giảm giá, tổng = tiền hàng + phí vận chuyển.
    await expect(page.locator('dt:text-matches("^Giảm")')).toHaveCount(0);
    expect(checkoutTotal).toBe(checkoutSubtotal + checkoutShipping);

    await placeCodOrder(page);
    expect(await readVnd(page, "Tạm tính")).toBe(checkoutSubtotal);
    expect(await readVnd(page, "Phí giao hàng")).toBe(checkoutShipping);
    expect(await readVnd(page, "Tổng cộng")).toBe(checkoutTotal);
  });
});
