import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

import type { Buyer } from "./fixtures";

export const ORDER_REF = /XS-[A-Z0-9]{4,12}/;

/**
 * Vào danh mục bằng menu của header: desktop dùng thanh điều hướng; màn nhỏ (menu thanh bên ẩn) mở drawer "Mở menu
 * danh mục" rồi chọn liên kết trong dialog.
 */
export async function openCategoryFromMenu(page: Page, name: string): Promise<void> {
  const inline = page
    .getByRole("navigation", { name: "Danh mục", exact: true })
    .getByRole("link", { name, exact: true });
  if (await inline.first().isVisible()) {
    await inline.first().click();
    return;
  }
  await page.getByRole("button", { name: "Mở menu danh mục" }).click();
  await page.getByRole("dialog", { name: "Danh mục" }).getByRole("link", { name, exact: true }).click();
}

/** Trang chủ → danh mục "Nữ" bằng menu → thẻ sản phẩm đầu tiên → trang chi tiết (PDP). */
export async function openFirstProductFromHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await openCategoryFromMenu(page, "Nữ");
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
export async function fillCheckout(page: Page, payment: "cod" | "vnpay", buyer: Buyer): Promise<void> {
  await page.getByLabel("Họ và tên").fill(buyer.name);
  await page.getByLabel("Số điện thoại").fill(buyer.phone);
  await page.getByLabel("Email").fill(buyer.email);
  await page.getByLabel("Tỉnh/thành phố").selectOption({ label: "Thành phố Hà Nội" });
  const ward = page.getByLabel("Phường/xã");
  await expect(ward).toBeEnabled();
  await ward.selectOption({ index: 1 });
  await page.getByLabel("Số nhà, tên đường").fill(buyer.addressLine);
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

/**
 * Cả hành trình khách vãng lai tới trang checkout đã điền xong. `onStep` (tuỳ chọn) chạy sau mỗi bước — dùng để quét
 * axe ở từng màn (IND-ECOM-016).
 */
export async function guestJourneyToFilledCheckout(
  page: Page,
  payment: "cod" | "vnpay",
  buyer: Buyer,
  onStep: (label: string) => Promise<void> = async () => {},
): Promise<void> {
  await openFirstProductFromHome(page);
  await onStep("PDP");
  await addAvailableVariantToCart(page);
  await onStep("PDP đã thêm giỏ");
  await openCartFromPdp(page);
  await onStep("giỏ hàng");
  await openCheckoutFromCart(page);
  await onStep("checkout trống");
  await fillCheckout(page, payment, buyer);
  await onStep(`checkout đã điền (${payment})`);
}

/** Bấm "Đặt hàng" và trả mã đơn khi đã sang trang đơn (COD). */
export async function placeCodOrder(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Đặt hàng", exact: true }).click();
  await expect(page).toHaveURL(/\/don-hang\/XS-/);
  const ref = ORDER_REF.exec(new URL(page.url()).pathname)?.[0];
  if (!ref) throw new Error(`Không đọc được mã đơn từ ${page.url()}`);
  return ref;
}

/** Phần tử đang giữ focus có chỉ báo nhìn thấy được (outline ≥ 2px hoặc box-shadow) — WCAG 2.4.7/2.4.13. */
export async function expectFocusVisible(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    // Chỉ báo có thể nằm ở chính phần tử hoặc ở ::after/::before (mẫu "link phủ toàn thẻ" của ProductCard).
    const ring = (cs: CSSStyleDeclaration) => ({
      outlineStyle: cs.outlineStyle,
      outlineWidth: Number.parseFloat(cs.outlineWidth),
      boxShadow: cs.boxShadow,
    });
    return {
      tag: el.tagName.toLowerCase(),
      rings: [
        ring(getComputedStyle(el)),
        ring(getComputedStyle(el, "::after")),
        ring(getComputedStyle(el, "::before")),
      ],
    };
  });
  expect(info, `${label}: không có phần tử nào giữ focus`).not.toBeNull();
  const visible = (info?.rings ?? []).some(
    (r) => (r.outlineStyle !== "none" && r.outlineWidth >= 2) || r.boxShadow !== "none",
  );
  expect(visible, `${label}: focus không nhìn thấy được (${JSON.stringify(info)})`).toBe(true);
}

/**
 * Chỉ dùng phím Tab để đưa focus tới `target`; tới nơi thì kiểm chỉ báo focus. Quá `max` lần Tab mà chưa tới → lỗi
 * (bẫy focus hoặc thứ tự Tab hỏng).
 */
export async function tabTo(
  page: Page,
  target: Locator,
  label: string,
  { max = 80 }: { max?: number } = {},
): Promise<void> {
  const isFocused = () => target.first().evaluate((el) => el === document.activeElement);
  for (let i = 0; i <= max; i += 1) {
    if (await isFocused().catch(() => false)) {
      await expectFocusVisible(page, label);
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`${label}: không tới được bằng ${max} lần Tab (bẫy focus hoặc thứ tự Tab hỏng)`);
}

/** Bộ tag axe bắt buộc (STD-A11Y-002, UX-A11Y-001): WCAG 2.0 A/AA + 2.1 AA + 2.2 AA. */
export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/**
 * Quét axe trang hiện tại: 0 vi phạm ở MỌI mức (minor/moderate/serious/critical). Có kiểm "không xanh giả": axe
 * phải thật sự chạy luật. `label` nêu rõ màn/bước khi đỏ.
 */
export async function expectNoA11yViolations(page: Page, label: string): Promise<void> {
  // Điều kiện sẵn sàng (không phải nới timeout): Next stream <title> sau phần thân; máy tải nặng thì axe chạy trước khi
  // tiêu đề tới → luật `document-title` đỏ giả. Chờ tiêu đề có nội dung rồi mới quét — tiêu đề rỗng thật vẫn đỏ.
  await expect(page, `axe (${label}): trang không có <title>`).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(A11Y_TAGS).analyze();
  expect(results.passes.length, `axe (${label}): không có luật nào chạy`).toBeGreaterThan(10);
  const report = results.violations.map(
    (v) =>
      `${v.id} [${v.impact ?? "?"}] ${v.help}\n` +
      v.nodes.map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n"),
  );
  expect(results.violations, `axe (${label}):\n${report.join("\n")}`).toEqual([]);
}
