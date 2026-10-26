import { expect, test } from "@playwright/test";
import { expectNoA11yViolations } from "./helpers";

/**
 * T-116 / UX-RESP-005: ở project `mobile` (cảm ứng thật, `(hover: none)`) mọi menu/bộ lọc mở được bằng chạm, không cần
 * hover. Project desktop loại spec này (playwright.config.ts) vì không có màn cảm ứng.
 */
test("thiết bị cảm ứng: (hover: none), (pointer: coarse)", async ({ page }) => {
  await page.goto("/");
  const media = await page.evaluate(() => ({
    hoverNone: matchMedia("(hover: none)").matches,
    coarse: matchMedia("(pointer: coarse)").matches,
    touch: navigator.maxTouchPoints > 0,
  }));
  expect(media).toEqual({ hoverNone: true, coarse: true, touch: true });
});

test("chạm: mở menu danh mục → vào danh mục → mở bộ lọc → áp dụng → mở sản phẩm", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Mở menu danh mục" }).tap();
  const menu = page.getByRole("dialog", { name: "Danh mục" });
  await expect(menu).toBeVisible();
  await expectNoA11yViolations(page, "mobile — menu mở");
  await menu.getByRole("link", { name: "Nữ", exact: true }).tap();
  await expect(page).toHaveURL(/\/danh-muc\/nu/);
  await expect(menu).toBeHidden();

  // Bộ lọc dạng drawer (sidebar chỉ có ở desktop).
  await page.getByRole("button", { name: /^Bộ lọc/ }).tap();
  const filters = page.getByRole("dialog", { name: /Bộ lọc/ });
  await expect(filters).toBeVisible();
  await filters.getByRole("checkbox").first().tap();
  await filters.getByRole("button", { name: /^Xem/ }).tap();
  await expect(page).toHaveURL(/[?&](color|size|material)=/);
  await expect(page.locator("main article h3 a").first()).toBeVisible();

  await page.locator("main article h3 a").first().tap();
  await expect(page).toHaveURL(/\/san-pham\//);
  // Nút mua đủ lớn để chạm (>= 44 CSS px, DESIGN.md --touch-min).
  const cta = page.getByRole("button", { name: /Thêm vào giỏ|Chọn size|Chọn màu/ }).first();
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
