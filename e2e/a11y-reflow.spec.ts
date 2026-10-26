import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  addAvailableVariantToCart,
  fillCheckout,
  openCartFromPdp,
  openCheckoutFromCart,
  placeCodOrder,
} from "./helpers";

/**
 * AT25: 6 màn cốt lõi (trang chủ, danh mục, PDP, giỏ, checkout, trang đơn) — axe WCAG 2.1 A/AA không có vi phạm
 * serious/critical, và reflow ở 320 px không cuộn ngang (WCAG 1.4.10). Mỗi màn kiểm ở desktop rồi ở 320 px.
 */
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 320, height: 640 };
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function auditAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  // Chống "xanh giả": axe phải thật sự chạy luật trên trang (không phải trang rỗng/lỗi).
  expect(results.passes.length, `axe (${label}): không có luật nào chạy`).toBeGreaterThan(10);
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = blocking.map(
    (v) =>
      `${v.id} [${v.impact}] ${v.help}\n` +
      v.nodes.map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1] ?? ""}`).join("\n"),
  );
  expect(blocking, `axe (${label}):\n${report.join("\n")}`).toEqual([]);
}

async function auditScreen(page: Page, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await auditAxe(page, `${name} @${DESKTOP.width}`);
  await page.setViewportSize(NARROW);
  // Chờ theo trạng thái (poll tới khi bố cục ổn định), không sleep cứng.
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: `${name}: cuộn ngang ở ${NARROW.width}px (scrollWidth > clientWidth)`, timeout: 5_000 },
    )
    .toBeLessThanOrEqual(0);
  await auditAxe(page, `${name} @${NARROW.width}`);
  await page.setViewportSize(DESKTOP);
}

test.describe.serial("AT25 — axe + reflow 320 px trên 6 màn cốt lõi", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: DESKTOP })).newPage();
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test("1. trang chủ", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await auditScreen(page, "trang chủ");
  });

  test("2. danh mục", async () => {
    await page.getByRole("navigation").getByRole("link", { name: "Nữ", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Nữ" })).toBeVisible();
    await expect(page.locator("main article h3 a").first()).toBeVisible();
    await auditScreen(page, "danh mục");
  });

  test("3. chi tiết sản phẩm", async () => {
    await page.locator("main article h3 a").first().click();
    await expect(page).toHaveURL(/\/san-pham\//);
    await expect(page.getByRole("button", { name: /Thêm vào giỏ|Chọn size|Chọn màu/ }).first()).toBeVisible();
    await auditScreen(page, "PDP");
  });

  test("4. giỏ hàng", async () => {
    await addAvailableVariantToCart(page);
    await openCartFromPdp(page);
    await auditScreen(page, "giỏ hàng");
  });

  test("5. checkout", async () => {
    await openCheckoutFromCart(page);
    await auditScreen(page, "checkout");
  });

  test("6. trang đơn", async () => {
    await fillCheckout(page, "cod");
    await placeCodOrder(page);
    await expect(page.getByText("Đã nhận đơn — chờ xác nhận")).toBeVisible();
    await auditScreen(page, "trang đơn");
  });
});
