import { expect, test, type Locator, type Page } from "@playwright/test";
import { countOrders } from "./db.mjs";
import { ORDER_REF, expectFocusVisible, expectNoA11yViolations, tabTo } from "./helpers";

/**
 * T-115 / UX-A11Y-003: cả luồng mua (tìm → lọc → PDP chọn biến thể → giỏ → checkout COD → xác nhận) chỉ bằng bàn phím.
 * Chỉ dùng `keyboard.press('Tab'|'Enter'|'Space'|'Escape'|phím mũi tên)` và `keyboard.type` để điều khiển; `click`/`fill`/
 * `check`/`selectOption` bị cấm trong file này. Mỗi chặng kiểm chỉ báo focus nhìn thấy được và không bẫy focus
 * (`tabTo` đếm số lần Tab, quá trần là lỗi). Chạy ở project desktop (bộ lọc dạng sidebar; project mobile loại spec này qua testIgnore).
 */

const KEYBOARD_BUYER = {
  name: "Trần Văn Bình",
  phone: "0987654321",
  email: "ban.phim.e2e@example.com",
  addressLine: "45 Phố Huế, tầng 2, căn 201",
};

/** Tab tới `target` rồi Enter (liên kết/nút). */
async function activate(page: Page, target: Locator, label: string): Promise<void> {
  await tabTo(page, target, label);
  await page.keyboard.press("Enter");
}

/** Tab tới ô nhập, gõ chữ bằng bàn phím và kiểm giá trị. */
async function typeInto(page: Page, field: Locator, text: string, label: string): Promise<void> {
  await tabTo(page, field, label);
  await page.keyboard.type(text);
  await expect(field, `${label}: giá trị đã gõ`).toHaveValue(text);
}

test.describe("UX-A11Y-003 — chỉ bàn phím", () => {
  test("skip link: Tab đầu tiên hiện liên kết và Enter đưa focus tới nội dung chính", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Bỏ qua tới nội dung" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport({ ratio: 1 });
    await expectFocusVisible(page, "skip link");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#noi-dung$/);
    await expect(page.locator("main#noi-dung")).toBeFocused();
    // Tab tiếp đi vào nội dung, không quay lại header.
    await page.keyboard.press("Tab");
    const inMain = await page.evaluate(() =>
      document.querySelector("main")?.contains(document.activeElement),
    );
    expect(inMain, "sau skip link, Tab kế tiếp phải ở trong <main>").toBe(true);
  });

  test("Tab xuyên hết trang chủ tới chân trang, mọi chặng có focus nhìn thấy, không kẹt", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const lastFooterLink = page.locator("footer a").last();
    await tabTo(page, lastFooterLink, "liên kết cuối chân trang", { max: 150 });
    // Đi tiếp ra khỏi tài liệu rồi quay lại bằng Shift+Tab: không có bẫy.
    await page.keyboard.press("Shift+Tab");
    await expect(lastFooterLink).not.toBeFocused();
    await expectFocusVisible(page, "Shift+Tab từ chân trang");
  });

  test("dialog bảng size: Tab bị giữ trong dialog, Esc đóng và trả focus về nút mở", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("link", { name: "Nữ", exact: true }).first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/danh-muc\/nu/);
    await page.locator("main article h3 a").first().focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/san-pham\//);
    const guide = page.getByRole("button", { name: "Hướng dẫn chọn size" });
    await expect(guide, "sản phẩm đầu tiên phải có bảng size (seed)").toHaveCount(1);
    await activate(page, guide, "nút Hướng dẫn chọn size");
    const dialog = page.getByRole("dialog", { name: "Bảng size" });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null);
      expect(inside, `Tab lần ${i + 1} làm focus rời dialog`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(guide).toBeFocused();
  });

  test("luồng mua COD chỉ bằng bàn phím: tìm → lọc → PDP → giỏ → checkout → xác nhận", async ({ page }) => {
    test.setTimeout(180_000);
    const before = await countOrders();

    // 1. Trang chủ → "Tìm kiếm" (liên kết biểu tượng ở header).
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await activate(page, page.getByRole("link", { name: "Tìm kiếm" }), "liên kết Tìm kiếm");
    await expect(page).toHaveURL(/\/tim-kiem/);

    // 2. Gõ từ khóa, Enter gửi form (không chọn gợi ý).
    const searchBox = page.getByRole("combobox", { name: /Tìm theo/ });
    await typeInto(page, searchBox, "áo", "ô tìm kiếm");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tim-kiem\?.*q=/);
    await expect(page.getByRole("heading", { level: 1, name: /Kết quả cho/ })).toBeVisible();
    await expectNoA11yViolations(page, "bàn phím — kết quả tìm kiếm");

    // 3. Lọc: tích ô đầu tiên của bộ lọc (Space) rồi "Áp dụng bộ lọc" (Enter).
    const sidebar = page.getByRole("complementary", { name: "Bộ lọc" });
    const facet = sidebar.getByRole("checkbox").first();
    await tabTo(page, facet, "ô lọc đầu tiên");
    await page.keyboard.press("Space");
    await expect(facet).toBeChecked();
    await activate(page, sidebar.getByRole("button", { name: "Áp dụng bộ lọc" }), "nút Áp dụng bộ lọc");
    await expect(page).toHaveURL(/[?&](color|size|material)=/);
    await expect(page.locator("main article h3 a").first()).toBeVisible();

    // 4. Mở sản phẩm đầu tiên.
    await activate(page, page.locator("main article h3 a").first(), "thẻ sản phẩm đầu tiên");
    await expect(page).toHaveURL(/\/san-pham\//);

    // 5. Chọn màu + size còn hàng (Enter / Space) rồi "Thêm vào giỏ" (Enter).
    const colors = page.getByRole("group", { name: /^Màu/ }).getByRole("button");
    const color = colors.filter({ hasNotText: /hết hàng/ }).first();
    await tabTo(page, color, "màu còn hàng");
    await page.keyboard.press("Enter");
    await expect(color).toHaveAttribute("aria-pressed", "true");
    const sizeGroup = page.getByRole("group", { name: "Size", exact: true });
    const size = sizeGroup.locator("button:not([aria-disabled='true'])").first();
    await tabTo(page, size, "size còn hàng");
    await page.keyboard.press("Space");
    await expect(size).toHaveAttribute("aria-pressed", "true");
    await activate(page, page.getByRole("button", { name: "Thêm vào giỏ" }).first(), "nút Thêm vào giỏ");
    await expect(page.getByRole("link", { name: "Xem giỏ hàng" })).toBeVisible();

    // 6. Giỏ → thanh toán.
    await activate(page, page.getByRole("link", { name: "Xem giỏ hàng" }), "liên kết Xem giỏ hàng");
    await expect(page.getByRole("heading", { level: 1, name: /^Giỏ hàng \(\d+\)/ })).toBeVisible();
    await expectNoA11yViolations(page, "bàn phím — giỏ hàng");
    await activate(page, page.getByRole("link", { name: "Thanh toán" }), "liên kết Thanh toán");
    await expect(page).toHaveURL(/\/thanh-toan$/);

    // 7. Điền checkout: ô nhập bằng gõ phím; <select> bằng gõ chữ/mũi tên; radio bằng Space.
    await typeInto(page, page.getByLabel("Họ và tên"), KEYBOARD_BUYER.name, "Họ và tên");
    await typeInto(page, page.getByLabel("Số điện thoại"), KEYBOARD_BUYER.phone, "Số điện thoại");
    await typeInto(page, page.getByLabel("Email"), KEYBOARD_BUYER.email, "Email");
    const province = page.getByLabel("Tỉnh/thành phố");
    await tabTo(page, province, "Tỉnh/thành phố");
    await page.keyboard.press("ArrowDown"); // lựa chọn đầu tiên sau placeholder: Thành phố Hà Nội
    await expect(province.locator("option:checked")).toHaveText("Thành phố Hà Nội");
    const ward = page.getByLabel("Phường/xã");
    await expect(ward).toBeEnabled();
    await tabTo(page, ward, "Phường/xã");
    await page.keyboard.press("ArrowDown");
    await expect(ward).not.toHaveValue("");
    await typeInto(
      page,
      page.getByLabel("Số nhà, tên đường"),
      KEYBOARD_BUYER.addressLine,
      "Số nhà, tên đường",
    );
    const cod = page.getByRole("radio", { name: "Thanh toán khi nhận hàng (COD)" });
    await tabTo(page, cod, "radio COD");
    await page.keyboard.press("Space");
    await expect(cod).toBeChecked();
    await expect(
      page.getByTestId("totals").locator("div", { hasText: "Tổng phải trả" }).locator("dd"),
    ).toHaveText(/\d/);
    await expect(page.getByTestId("totals")).not.toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(page, "bàn phím — checkout đã điền");

    // 8. Đặt hàng bằng Enter → trang xác nhận.
    await activate(page, page.getByRole("button", { name: "Đặt hàng", exact: true }), "nút Đặt hàng");
    await expect(page).toHaveURL(/\/don-hang\/XS-/);
    const ref = ORDER_REF.exec(new URL(page.url()).pathname)?.[0];
    expect(ref, "mã đơn trong URL").toBeTruthy();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(ref ?? "");
    await expect(page.getByText("Đã nhận đơn — chờ xác nhận")).toBeVisible();
    await expectNoA11yViolations(page, "bàn phím — trang đơn");
    expect(await countOrders()).toBe(before + 1);

    // Trang xác nhận vẫn đi Tab được (không bẫy) tới liên kết cuối chân trang.
    await tabTo(page, page.locator("footer a").last(), "chân trang trang đơn", { max: 150 });
  });
});
