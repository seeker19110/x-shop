import { countOrdersFor } from "./cleanup.mjs";
import { expect, test } from "./fixtures";
import {
  addAvailableVariantToCart,
  fillCheckout,
  openCartFromPdp,
  openCheckoutFromCart,
  openFirstProductFromHome,
  placeCodOrder,
} from "./helpers";

/**
 * T-201 (QA-E2E-005): hai phiên trình duyệt riêng (hai browser context, không chia cookie) — phiên B không thấy giỏ
 * hay đơn của phiên A, kể cả khi đoán đúng URL đơn; tra đơn phải qua xác minh theo thiết kế (cookie phiên đơn HttpOnly
 * hoặc liên kết gửi tới liên hệ đã dùng khi đặt), không phải chỉ biết mã đơn.
 */
test.describe("T-201 — cô lập phiên", () => {
  test("phiên B không thấy giỏ và đơn của phiên A, kể cả đoán URL đơn", async ({
    page,
    context,
    browser,
    baseURL,
    buyer,
  }) => {
    const sessionB = await browser.newContext({ baseURL, locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
    try {
      const pageB = await sessionB.newPage();

      // Phiên A thêm hàng vào giỏ.
      await openFirstProductFromHome(page);
      await addAvailableVariantToCart(page);
      await openCartFromPdp(page);
      await expect(page.getByRole("heading", { level: 1, name: /^Giỏ hàng \([1-9]\d*\)/ })).toBeVisible();
      const cartCookieA = (await context.cookies()).find((c) => c.name === "xs_cart");
      expect(cartCookieA, "phiên A phải có cookie giỏ").toBeDefined();

      // Phiên B (không có cookie giỏ của A) thấy giỏ trống, không có đường tới thanh toán.
      await pageB.goto("/gio-hang");
      await expect(pageB.getByRole("link", { name: "Tiếp tục mua sắm" }).first()).toBeVisible();
      await expect(pageB.getByRole("heading", { level: 1, name: /^Giỏ hàng \([1-9]/ })).toHaveCount(0);
      await expect(pageB.getByRole("link", { name: "Thanh toán" })).toHaveCount(0);
      const cartCookieB = (await sessionB.cookies()).find((c) => c.name === "xs_cart");
      expect(cartCookieB?.value).not.toBe(cartCookieA?.value);

      // Phiên A đặt đơn COD.
      await openCheckoutFromCart(page);
      await fillCheckout(page, "cod", buyer);
      const ref = await placeCodOrder(page);
      expect(await countOrdersFor(buyer.email)).toBe(1);

      // Phiên B đoán URL đơn: bị yêu cầu xác thực, không lộ dữ liệu của A.
      await pageB.goto(`/don-hang/${ref}`);
      await expect(pageB.getByText("Bạn cần xác thực để xem đơn này")).toBeVisible();
      for (const secret of [buyer.name, buyer.phone, buyer.email, buyer.addressLine]) {
        await expect(pageB.getByText(secret, { exact: false })).toHaveCount(0);
      }
      await expect(pageB.getByRole("button", { name: "Hủy đơn" })).toHaveCount(0);

      // Mã đơn không tồn tại cho cùng thông điệp với đơn có thật (không lộ đơn có tồn tại).
      await pageB.goto("/don-hang/XS-ZZZZZZ9");
      await expect(pageB.getByText("Bạn cần xác thực để xem đơn này")).toBeVisible();

      // Phiên A vẫn xem được đơn của mình.
      await page.goto(`/don-hang/${ref}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
    } finally {
      await sessionB.close();
    }
  });
});
