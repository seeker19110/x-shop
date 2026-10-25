import { expect, type Page } from "@playwright/test";

/** SĐT di động hợp lệ dùng cho mọi đơn E2E (không phải số thật của ai). */
export const BUYER = {
  name: "Nguyễn Thị Ánh Tuyết",
  phone: "0912345678",
  email: "khach.e2e@example.com",
  addressLine: "12 Phố Điện Biên Phủ, tòa A, căn 305",
};

export const ORDER_REF = /XS-[A-Z0-9]{4,12}/;

/** Trang chủ → danh mục "Nữ" bằng menu → thẻ sản phẩm đầu tiên → trang chi tiết (PDP). */
export async function openFirstProductFromHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.getByRole("navigation").getByRole("link", { name: "Nữ", exact: true }).first().click();
  await expect(page).toHaveURL(/\/danh-muc\/nu/);
  await expect(page.getByRole("heading", { level: 1, name: "Nữ" })).toBeVisible();
  await page.locator("main article h3 a").first().click();
  await expect(page).toHaveURL(/\/san-pham\//);
  await expect(page.getByRole("button", { name: /Thêm vào giỏ|Chọn size|Chọn màu/ }).first()).toBeVisible();
}

/** Chọn màu còn hàng đầu tiên, size còn hàng đầu tiên rồi thêm vào giỏ; chờ thông báo + liên kết "Xem giỏ hàng". */
export async function addAvailableVariantToCart(page: Page): Promise<void> {
  const colors = page.getByRole("group", { name: /^Màu/ }).getByRole("button");
  await colors
    .filter({ hasNotText: /hết hàng/ })
    .first()
    .click();
  // Size còn hàng: nút không có aria-disabled.
  const sizeGroup = page.getByRole("group", { name: "Size", exact: true });
  await sizeGroup.locator("button:not([aria-disabled='true'])").first().click();
  await expect(sizeGroup.locator("button[aria-pressed='true']")).toHaveCount(1);
  await page.getByRole("button", { name: "Thêm vào giỏ" }).first().click();
  await expect(page.getByRole("link", { name: "Xem giỏ hàng" })).toBeVisible();
}

/** PDP → giỏ (qua liên kết "Xem giỏ hàng"). */
export async function openCartFromPdp(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Xem giỏ hàng" }).click();
  await expect(page).toHaveURL(/\/gio-hang/);
  await expect(page.getByRole("heading", { level: 1, name: /^Giỏ hàng \(\d+\)/ })).toBeVisible();
}

/** Giỏ → checkout một trang. */
export async function openCheckoutFromCart(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Thanh toán" }).click();
  await expect(page).toHaveURL(/\/thanh-toan$/);
  await expect(page.getByRole("heading", { level: 1, name: "Thanh toán" })).toBeVisible();
}

/** Điền liên hệ + địa chỉ 2 cấp (tỉnh → phường/xã) + chọn phương thức; chờ báo giá của server có tổng tiền. */
export async function fillCheckout(page: Page, payment: "cod" | "vnpay"): Promise<void> {
  await page.getByLabel("Họ và tên").fill(BUYER.name);
  await page.getByLabel("Số điện thoại").fill(BUYER.phone);
  await page.getByLabel("Email").fill(BUYER.email);
  await page.getByLabel("Tỉnh/thành phố").selectOption({ label: "Thành phố Hà Nội" });
  const ward = page.getByLabel("Phường/xã");
  await expect(ward).toBeEnabled();
  await ward.selectOption({ index: 1 });
  await page.getByLabel("Số nhà, tên đường").fill(BUYER.addressLine);
  const label = payment === "cod" ? "Thanh toán khi nhận hàng (COD)" : "Thanh toán online qua VNPAY";
  await page.getByRole("radio", { name: label }).check();
  await waitForQuote(page);
}

/** Báo giá của server đã về: dòng "Tổng phải trả" có số tiền thật (không còn "Đang tính…"/"Nhập địa chỉ"). */
export async function waitForQuote(page: Page): Promise<void> {
  const total = page.getByTestId("totals").locator("div", { hasText: "Tổng phải trả" }).locator("dd");
  await expect(total).toHaveText(/\d/);
  await expect(page.getByTestId("totals")).not.toHaveAttribute("aria-busy", "true");
}

/** Cả hành trình khách vãng lai tới trang checkout đã điền xong. */
export async function guestJourneyToFilledCheckout(page: Page, payment: "cod" | "vnpay"): Promise<void> {
  await openFirstProductFromHome(page);
  await addAvailableVariantToCart(page);
  await openCartFromPdp(page);
  await openCheckoutFromCart(page);
  await fillCheckout(page, payment);
}

/** Bấm "Đặt hàng" và trả mã đơn khi đã sang trang đơn (COD). */
export async function placeCodOrder(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Đặt hàng", exact: true }).click();
  await expect(page).toHaveURL(/\/don-hang\/XS-/);
  const ref = ORDER_REF.exec(new URL(page.url()).pathname)?.[0];
  if (!ref) throw new Error(`Không đọc được mã đơn từ ${page.url()}`);
  return ref;
}
