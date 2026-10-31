import type { Page } from "@playwright/test";
import { expect, test, XSS_PAYLOADS, type XssContent } from "./fixtures";

/**
 * T-180 (SEC-WEB-004) — DAST XSS bằng E2E trên hệ thật. Nội dung catalog (tên, mô tả, handle sản phẩm; tên danh mục) được
 * seed qua Admin API với payload `<img onerror>` / `javascript:` / `"><svg onload>`; payload cũng được đưa vào ô tìm
 * kiếm, tham số lọc, query string và đường dẫn URL. Mỗi payload tự đặt cờ `window.__xss` nếu chạy. Khẳng định: không hộp
 * thoại, không cờ, không phần tử mang trình xử lý sự kiện / href `javascript:` trong DOM, và CSP (header) chặn script
 * nội tuyến (tự chèn một script không nonce và chờ `securitypolicyviolation`).
 *
 * Chỉ chạy ở project desktop (kiểm tra phía server/DOM, không phụ thuộc viewport).
 */

declare global {
  interface Window {
    __xss?: unknown;
  }
}

const q = encodeURIComponent;

/** Trang hiện tại không có dấu hiệu XSS: cờ, phần tử `on*`, URL nguy hiểm trong thuộc tính điều hướng/nguồn. */
async function expectClean(page: Page, dialogs: string[], where: string): Promise<void> {
  expect(await page.evaluate(() => window.__xss), `${where}: cờ window.__xss`).toBeUndefined();
  expect(dialogs, `${where}: hộp thoại`).toEqual([]);
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    // Bỏ ký tự điều khiển/khoảng trắng/định dạng vô hình mà trình duyệt bỏ qua trong scheme ("java\tscript:").
    const normalize = (v: string) =>
      Array.from(v)
        .filter((c) => {
          const n = c.charCodeAt(0);
          return !(n <= 0x20 || (n >= 0x7f && n <= 0xa0) || (n >= 0x2000 && n <= 0x200f) || n === 0xfeff);
        })
        .join("")
        .toLowerCase();
    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) out.push(`${el.tagName}[${name}]`);
        if (["href", "src", "action", "formaction", "xlink:href", "data", "srcset"].includes(name)) {
          const v = normalize(attr.value);
          if (v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html"))
            out.push(`${el.tagName}[${name}=${attr.value.slice(0, 40)}]`);
        }
      }
    }
    // Phần tử do payload tạo ra (không phải do trang): img/svg/a lạ trong nội dung văn bản.
    if (document.querySelector('img[src="x"], svg[onload], a[href^="javascript" i]'))
      out.push("phần tử payload");
    return out;
  });
  expect(bad, `${where}: DOM nguy hiểm`).toEqual([]);
}

async function visit(page: Page, dialogs: string[], url: string): Promise<void> {
  const res = await page.goto(url);
  expect(res, url).not.toBeNull();
  expect(res!.status(), url).toBeLessThan(500);
  await page.waitForLoadState("networkidle");
  await expectClean(page, dialogs, url);
}

function trackDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  return dialogs;
}

test.describe("DAST XSS (T-180, SEC-WEB-004)", () => {
  test.skip(({ isMobile }) => isMobile, "kiểm tra phía server/DOM, không phụ thuộc viewport");

  test("payload trong query string, ô tìm kiếm, tham số lọc và đường dẫn không chạy script", async ({
    page,
  }) => {
    const dialogs = trackDialogs(page);
    const { img, link, svg } = XSS_PAYLOADS;
    const all = `${img}${svg}`;

    for (const payload of [img, link, svg, all, "javascript:alert(1)", "';window.__xss=1;//"]) {
      await visit(page, dialogs, `/tim-kiem?q=${q(payload)}`);
      await visit(page, dialogs, `/tim-kiem?color=${q(payload)}&size=${q(payload)}&material=${q(payload)}`);
      await visit(page, dialogs, `/tim-kiem?sort=${q(payload)}&page=${q(payload)}&price_min=${q(payload)}`);
      await visit(page, dialogs, `/danh-muc/nu?q=${q(payload)}&color=${q(payload)}&${q(payload)}=1`);
      await visit(page, dialogs, `/tim-kiem?${q(payload)}=${q(payload)}`);
      await visit(page, dialogs, `/san-pham/${q(payload)}`);
      await visit(page, dialogs, `/danh-muc/${q(payload)}`);
      await visit(page, dialogs, `/don-hang/${q(payload)}`);
      await visit(page, dialogs, `/thanh-toan/ket-qua?vnp_TxnRef=${q(payload)}&vnp_OrderInfo=${q(payload)}`);
    }

    // Ô tìm kiếm: gõ payload rồi gửi form → URL phản chiếu + tiêu đề "Kết quả cho …" vẫn là văn bản.
    await page.goto("/tim-kiem");
    const box = page.getByRole("combobox", { name: /Tìm theo/ });
    await box.fill(all);
    await box.press("Enter");
    await page.waitForURL(/\/tim-kiem\?.*q=/);
    await page.waitForLoadState("networkidle");
    await expectClean(page, dialogs, "gõ vào ô tìm kiếm");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("<img src=x");
    expect(dialogs).toEqual([]);
  });

  test("nội dung catalog độc hại (tên, mô tả, handle) hiển thị như văn bản, link không thành javascript:", async ({
    page,
    xssContent,
  }: {
    page: Page;
    xssContent: XssContent;
  }) => {
    const dialogs = trackDialogs(page);

    // Chờ read model + webhook đưa nội dung độc hại tới storefront (cache dữ liệu 60 s nếu webhook hỏng).
    await expect
      .poll(
        async () => {
          await page.goto(`/tim-kiem?q=${q("XSSPROBE")}`);
          return page.locator("main article").count();
        },
        { timeout: 40_000, message: "sản phẩm XSSPROBE chưa vào kết quả tìm kiếm" },
      )
      .toBeGreaterThan(0);
    await expectClean(page, dialogs, "kết quả tìm kiếm chứa tên độc hại");
    await expect(page.locator("main article").first()).toContainText("<img src=x onerror");

    // Handle chứa payload bị Admin API từ chối ngay lúc nhập (lớp phòng thủ thứ nhất).
    expect(xssContent.badHandleStatus).toBe(400);

    // Thẻ sản phẩm → PDP qua đúng liên kết do storefront dựng từ handle độc hại.
    const href = await page.locator("main article h3 a").first().getAttribute("href");
    expect(href).not.toBeNull();
    expect(href!.toLowerCase()).not.toContain("javascript:");
    await visit(page, dialogs, `/san-pham/${q(xssContent.productHandle)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("XSSPROBE");
    await expect(page.locator("body")).toContainText("javascript:alert(1)");

    // Trang danh mục có tên độc hại, danh sách lọc/tìm trong danh mục, tìm theo tên danh mục.
    await visit(page, dialogs, `/danh-muc/${xssContent.categoryHandle}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("XSSCAT");
    await visit(page, dialogs, `/danh-muc/${xssContent.categoryHandle}?q=${q("XSSPROBE")}`);
    await visit(page, dialogs, `/tim-kiem?q=${q("XSSCAT")}`);
    await visit(page, dialogs, "/");
    await visit(page, dialogs, "/gio-hang");

    // JSON-LD của PDP: không thể đóng thẻ script sớm trong dữ liệu; vẫn là JSON hợp lệ.
    await page.goto(`/san-pham/${q(xssContent.productHandle)}`);
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ld.length).toBeGreaterThan(0);
    for (const text of ld) expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test("CSP có mặt và chặn script nội tuyến không nonce", async ({ page }) => {
    const dialogs = trackDialogs(page);
    const res = await page.goto(`/tim-kiem?q=${q(XSS_PAYLOADS.svg)}`);
    const csp = res!.headers()["content-security-policy"];
    expect(csp, "header Content-Security-Policy").toBeDefined();
    const scriptSrc = csp!
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc, "có script-src").toBeDefined();
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    await page.waitForLoadState("networkidle");

    // Mô phỏng XSS phản chiếu thật: trình duyệt nhận HTML có script nội tuyến + handler nội tuyến KHÔNG mang nonce, kèm
    // đúng header CSP của server. Parser-inserted script không nonce phải bị chặn (một script do JS đã tin cậy chèn
    // vào thì được 'strict-dynamic' cho phép theo thiết kế nên không dùng để kiểm).
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener("securitypolicyviolation", (e) => seen.push(e.violatedDirective));
    });
    await page.route("**/tim-kiem?probe=1", async (route) => {
      const upstream = await route.fetch();
      const html = (await upstream.text()).replace(
        "<body",
        '<body><script>window.__xss="inline-script"</script><img src=x onerror="window.__xss=\'inline-handler\'"',
      );
      await route.fulfill({ response: upstream, body: html });
    });
    await page.goto("/tim-kiem?probe=1");
    await page.waitForLoadState("networkidle");
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(violations.length, "securitypolicyviolation").toBeGreaterThan(0);
    expect(violations.some((v) => v.startsWith("script-src"))).toBe(true);
    expect(await page.evaluate(() => window.__xss), "script nội tuyến không được chạy").toBeUndefined();
    expect(dialogs).toEqual([]);
  });
});
