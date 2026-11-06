import { countOrdersFor } from "./cleanup.mjs";
import { expect, maskPhone, test } from "./fixtures";
import { expectNoA11yViolations, guestJourneyToFilledCheckout, placeCodOrder } from "./helpers";

/** R-001: khách không tài khoản mua COD từ trang chủ tới trang đơn; tra cứu đơn bảo mật. */
test.describe("R-001 — khách vãng lai mua COD", () => {
  test(
    "trang chủ → danh mục → PDP → giỏ → checkout một trang → đơn đã đặt; tra cứu bảo mật",
    { tag: "@smoke" },
    async ({ page, browser, buyer: BUYER }) => {
      expect(await countOrdersFor(BUYER.email)).toBe(0);
      await guestJourneyToFilledCheckout(page, "cod", BUYER, (label) =>
        expectNoA11yViolations(page, `COD — ${label}`),
      );
      await expect(page.getByText("Mua không cần tài khoản.")).toBeVisible();

      const ref = await placeCodOrder(page);

      // Trang đơn: đã đặt, COD, thông tin người nhận.
      await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
      await expect(page.getByText("Đã nhận đơn — chờ xác nhận")).toBeVisible();
      await expectNoA11yViolations(page, "COD — trang đơn");
      await expect(page.getByText("Thanh toán khi nhận hàng", { exact: true })).toBeVisible();
      // SĐT được che giữa ngay cả với chủ phiên đơn (PII).
      await expect(page.getByText(`${BUYER.name} · ${maskPhone(BUYER.phone)}`)).toBeVisible();
      await expect(page.getByText(BUYER.phone)).toHaveCount(0);
      await expect(page.getByText(BUYER.addressLine, { exact: false }).first()).toBeVisible();
      expect(await countOrdersFor(BUYER.email)).toBe(1);

      // Reload trang đơn không tạo đơn mới và vẫn xem được (cookie phiên đơn HttpOnly).
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
      expect(await countOrdersFor(BUYER.email)).toBe(1);

      // Giỏ đã gắn với đơn: không còn dòng hàng để đặt lần hai.
      await page.goto("/gio-hang");
      await expect(page.getByText("Tiếp tục mua sắm").first()).toBeVisible();

      // Tra cứu bảo mật: trình duyệt khác (không có cookie phiên đơn) biết mã đơn vẫn KHÔNG xem được đơn.
      const stranger = await browser.newContext({ baseURL: page.url().split("/don-hang/")[0] });
      try {
        const other = await stranger.newPage();
        await other.goto(`/don-hang/${ref}`);
        await expect(other.getByText("Bạn cần xác thực để xem đơn này")).toBeVisible();
        await expect(other.getByText(BUYER.phone)).toHaveCount(0);
        await expect(other.getByText(BUYER.name)).toHaveCount(0);

        // Form tra cứu: mã đúng + SĐT sai và mã đúng + SĐT đúng cho CÙNG thông điệp (không lộ đơn có tồn tại).
        await other.getByRole("link", { name: "Tra cứu đơn hàng" }).click();
        const notices: string[] = [];
        for (const phone of ["0987654321", BUYER.phone]) {
          await other.getByLabel("Số điện thoại đặt hàng").fill(phone);
          await other.getByRole("button", { name: "Gửi liên kết xem đơn" }).click();
          const status = other.getByRole("status").filter({ hasText: /\S/ });
          await expect(status).toBeVisible();
          notices.push((await status.textContent()) ?? "");
          await other.reload();
          await other.getByLabel("Mã đơn hàng").fill(ref);
        }
        expect(notices[0]).toBe(notices[1]);
        // Gửi liên kết xong vẫn chưa có quyền xem đơn.
        await other.goto(`/don-hang/${ref}`);
        await expect(other.getByText("Bạn cần xác thực để xem đơn này")).toBeVisible();
      } finally {
        await stranger.close();
      }
    },
  );
});
