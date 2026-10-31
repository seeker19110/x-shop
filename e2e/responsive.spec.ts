import { expect, test, type Page } from "@playwright/test";

/**
 * T-116 / UX-RESP-001: mọi route trong sitemap + trang tĩnh không cuộn ngang ở 320 CSS px (WCAG 1.4.10:
 * `scrollWidth <= clientWidth`). Chạy ở cả hai project (desktop, mobile); viewport do spec đặt nên kết quả như nhau.
 */
const NARROW = { width: 320, height: 800 };

/** Trang công khai không nằm trong sitemap (docs/ROUTES.md); cùng danh sách với a11y-reflow.spec.ts. */
const STATIC_ROUTES = [
  "/bao-mat",
  "/doi-tra-hoan-tien",
  "/giao-hang",
  "/tim-kiem?q=ao",
  "/tra-cuu-don",
  "/tra-cuu-don/xac-thuc",
  "/offline",
  "/gio-hang",
  "/thanh-toan",
];

/**
 * Độ tràn ngang (px). `/thanh-toan` với giỏ trống trả vỏ trang rồi Next chuyển tiếp sang `/gio-hang` ở client (redirect
 * khi streaming) — ngữ cảnh trang bị huỷ giữa chừng. Đó là điều hướng đúng của sản phẩm, không phải lỗi: coi lần đo
 * hỏng là "chưa ổn định" (Infinity → poll thử lại) và đo lại trên trang đích; giá trị cuối vẫn phải ≤ 0.
 */
async function overflow(page: Page): Promise<number> {
  try {
    return await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes("Execution context was destroyed"))
      return Number.POSITIVE_INFINITY;
    throw e;
  }
}

test("không cuộn ngang ở 320px trên mọi route trong sitemap + trang tĩnh", async ({ page, request }) => {
  test.setTimeout(600_000);
  const xml = await (await request.get("/sitemap/0.xml")).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1] ?? "").pathname);
  expect(urls.length, "sitemap rỗng").toBeGreaterThan(2);
  expect(urls.some((u) => u.startsWith("/danh-muc/"))).toBe(true);
  expect(urls.some((u) => u.startsWith("/san-pham/"))).toBe(true);

  await page.setViewportSize(NARROW);
  const routes = [...new Set([...urls, ...STATIC_ROUTES])];
  for (const route of routes) {
    const res = await page.goto(route);
    expect(res?.status(), `${route}: HTTP`).toBeLessThan(400);
    await expect(page.locator("main").first(), `${route}: không có <main>`).toBeVisible();
    // Poll tới khi bố cục ổn định (ảnh/font nạp xong) thay vì sleep cứng.
    await expect
      .poll(() => overflow(page), { message: `${route}: cuộn ngang ở ${NARROW.width}px`, timeout: 5_000 })
      .toBeLessThanOrEqual(0);
  }
});

test("menu danh mục ở màn nhỏ mở bằng nút (không cần hover) và đóng bằng Esc", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Mở menu danh mục" });
  await expect(opener).toBeVisible();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Danh mục" });
  await expect(dialog.getByRole("link", { name: "Nữ", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
