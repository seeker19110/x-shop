import { expect, test, type Page } from "@playwright/test";
import { newBuyer, cleanupBuyer, type Buyer } from "./fixtures";
import {
  A11Y_TAGS,
  addAvailableVariantToCart,
  expectNoA11yViolations,
  fillCheckout,
  openCartFromPdp,
  openCheckoutFromCart,
  placeCodOrder,
} from "./helpers";

/**
 * AT25 + T-114: axe (wcag2a, wcag2aa, wcag21aa, wcag22aa) KHÔNG vi phạm ở mọi mức trên 6 màn cốt lõi và trên MỌI route
 * của sitemap + các trang tĩnh; reflow ở 320 px không cuộn ngang (WCAG 1.4.10). Màn cốt lõi kiểm ở desktop rồi 320 px.
 */
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 320, height: 640 };

/** Trang không nằm trong sitemap nhưng là route công khai của storefront (docs/ROUTES.md). */
const STATIC_ROUTES = [
  "/bao-mat",
  "/doi-tra-hoan-tien",
  "/giao-hang",
  "/tim-kiem?q=ao",
  "/tra-cuu-don",
  "/tra-cuu-don/xac-thuc",
  "/offline",
  "/gio-hang",
];

test("bộ tag axe không bị rút bớt (wcag22aa)", () => {
  expect(A11Y_TAGS).toEqual(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  expect(A11Y_TAGS).toContain("wcag22aa");
});

test("axe 0 vi phạm ở mọi route trong sitemap + trang tĩnh", async ({ page, request }) => {
  test.setTimeout(600_000);
  const xml = await (await request.get("/sitemap/0.xml")).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1] ?? "").pathname);
  expect(urls.length, "sitemap rỗng").toBeGreaterThan(2);
  expect(urls).toContain("/");
  expect(urls.some((u) => u.startsWith("/danh-muc/"))).toBe(true);
  expect(urls.some((u) => u.startsWith("/san-pham/"))).toBe(true);
  for (const route of [...new Set([...urls, ...STATIC_ROUTES])]) {
    const res = await page.goto(route);
    expect(res?.status(), `${route}: HTTP`).toBeLessThan(400);
    await expect(page.locator("main").first(), `${route}: không có <main>`).toBeVisible();
    await expectNoA11yViolations(page, route);
  }
});

async function auditScreen(page: Page, name: string): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await expectNoA11yViolations(page, `${name} @${DESKTOP.width}`);
  await page.setViewportSize(NARROW);
  // Chờ theo trạng thái (poll tới khi bố cục ổn định), không sleep cứng.
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: `${name}: cuộn ngang ở ${NARROW.width}px (scrollWidth > clientWidth)`, timeout: 5_000 },
    )
    .toBeLessThanOrEqual(0);
  await expectNoA11yViolations(page, `${name} @${NARROW.width}`);
  await page.setViewportSize(DESKTOP);
}

test.describe.serial("AT25 — axe + reflow 320 px trên 6 màn cốt lõi", () => {
  let page: Page;
  // Khách riêng của cả chuỗi (6 màn dùng chung một phiên/giỏ/đơn); dọn ở afterAll — afterAll chạy cả khi test đỏ.
  const buyer: Buyer = newBuyer("a11y");

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: DESKTOP })).newPage();
  });
  test.afterAll(async () => {
    // `page` có thể chưa gán (beforeAll lỗi) — khi đó vẫn dọn theo email của buyer.
    const context = typeof page === "undefined" ? undefined : page.context();
    const cookies = (await context?.cookies().catch(() => [])) ?? [];
    await context?.close().catch(() => undefined);
    await cleanupBuyer(
      buyer,
      cookies.filter((c) => c.name === "xs_cart" && c.value !== "").map((c) => c.value),
    );
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
    await fillCheckout(page, "cod", buyer);
    await placeCodOrder(page);
    await expect(page.getByText("Đã nhận đơn — chờ xác nhận")).toBeVisible();
    await auditScreen(page, "trang đơn");
  });
});
