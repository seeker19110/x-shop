import { expect, test } from "./fixtures";
import {
  addAvailableVariantToCart,
  openCartFromPdp,
  openCheckoutFromCart,
  openFirstProductFromHome,
} from "./helpers";

/**
 * T-201 (UX-STATE-005, UX-CONTENT-005, PRF-WEB-001): API trả 500 → UI báo lỗi thân thiện, KHÔNG lộ stack, mã nội bộ hay
 * chi tiết; sau khi nguồn hồi phục, "Thử lại" tải được dữ liệu. Chặn bằng `page.route` ở route proxy
 * `/api/address/wards` mà trình duyệt gọi (cuộc gọi server-to-server của trang không chặn được từ trình duyệt).
 */
const LEAKY_BODY = JSON.stringify({
  message: "TypeError: Cannot read properties of undefined at /srv/medusa/src/api/store/x/address.ts:42:13",
  code: "XS_INTERNAL_DB_ECONNREFUSED",
  stack: "at Object.handler (/srv/medusa/src/api/store/x/address.ts:42:13)\n    at processTicksAndRejections",
});
const LEAK_MARKERS = [
  "TypeError",
  "XS_INTERNAL",
  "ECONNREFUSED",
  "/srv/medusa",
  "address.ts",
  "processTicksAndRejections",
  "Cannot read properties",
];

test.describe("T-201 — API 500", () => {
  test("phường/xã 500: thông báo thân thiện, không lộ chi tiết; Thử lại tải được sau khi hồi phục", async ({
    page,
  }) => {
    await openFirstProductFromHome(page);
    await addAvailableVariantToCart(page);
    await openCartFromPdp(page);
    await openCheckoutFromCart(page);

    const wardsApi = "**/api/address/wards**";
    let hits500 = 0;
    await page.route(wardsApi, (route) => {
      hits500 += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: LEAKY_BODY });
    });

    await page.getByLabel("Tỉnh/thành phố").selectOption({ label: "Thành phố Hà Nội" });

    // Thông báo thân thiện, có đường thử lại (4 trạng thái UI — D-144).
    await expect(page.getByText("Không tải được danh sách phường/xã.")).toBeVisible();
    const retry = page.getByRole("button", { name: /^Thử (tải )?lại$/ });
    await expect(retry).toBeVisible();
    expect(hits500, "UI phải thật sự gọi API đã bị chặn").toBeGreaterThan(0);

    // Không lộ chi tiết lỗi ở bất kỳ chỗ nào của trang (nội dung hiển thị lẫn HTML).
    const text = await page.locator("body").innerText();
    const html = await page.content();
    for (const marker of LEAK_MARKERS) {
      expect(text, `lộ "${marker}" ở nội dung hiển thị`).not.toContain(marker);
      expect(html, `lộ "${marker}" trong HTML`).not.toContain(marker);
    }
    expect(text).not.toMatch(/\b500\b/);

    // Ô phường/xã chưa có lựa chọn thật khi lỗi (chỉ còn mục gợi ý).
    await expect(page.getByLabel("Phường/xã").locator("option")).toHaveCount(1);

    // Hồi phục nguồn rồi Thử lại → có dữ liệu.
    await page.unroute(wardsApi);
    await retry.click();
    await expect(page.getByLabel("Phường/xã").locator("option")).not.toHaveCount(1);
    await expect(page.getByText("Không tải được danh sách phường/xã.")).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await page.getByLabel("Phường/xã").selectOption({ index: 1 });
  });
});
