import { expect, test } from "./fixtures";
import { addAvailableVariantToCart, openCartFromPdp, openFirstProductFromHome } from "./helpers";

/**
 * QA-E2E-001: nhóm `@smoke` — luồng lõi chạy nhanh trên mọi PR (`pnpm e2e:smoke`): xem sản phẩm, giỏ hàng (cùng với
 * checkout COD ở checkout-cod.spec.ts và VNPAY ở checkout-vnpay.spec.ts).
 */
test.describe("smoke — xem sản phẩm và giỏ hàng", () => {
  test(
    "xem sản phẩm: trang chủ → danh mục → PDP có tên, giá VND và nút mua",
    { tag: "@smoke" },
    async ({ page }) => {
      await openFirstProductFromHome(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // Giá hiển thị là số nguyên VND (dấu chấm phân cách nghìn + ₫), không phải "NaN"/"undefined".
      await expect(
        page
          .locator("main")
          .getByText(/\d{1,3}(\.\d{3})+\s*₫/)
          .first(),
      ).toBeVisible();
      await expect(page.getByText(/NaN|undefined/)).toHaveCount(0);
    },
  );

  test(
    "giỏ hàng: thêm → tăng số lượng → xóa dòng → giỏ trống",
    { tag: "@smoke" },
    async ({ page, buyer }) => {
      void buyer; // dùng fixture để teardown dọn giỏ của test này
      await openFirstProductFromHome(page);
      await addAvailableVariantToCart(page);
      await openCartFromPdp(page);
      await expect(page.getByRole("heading", { level: 1, name: "Giỏ hàng (1)" })).toBeVisible();

      await page.getByRole("button", { name: /^Tăng số lượng / }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Giỏ hàng (2)" })).toBeVisible();

      await page.getByRole("button", { name: /^Xóa/ }).click();
      await expect(page.getByText("Tiếp tục mua sắm").first()).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: /^Giỏ hàng \(\d+\)/ })).toHaveCount(0);
    },
  );
});
