import { countOrdersFor } from "./cleanup.mjs";
import { URLS } from "./env.mjs";
import { expect, test } from "./fixtures";
import { expectNoA11yViolations, guestJourneyToFilledCheckout, ORDER_REF } from "./helpers";

/** R-002: thanh toán VNPAY (cổng giả lập): chuyển cổng → IPN thành công → "Đang xác nhận" rồi "Đã thanh toán". */
test.describe("R-002 — khách vãng lai thanh toán VNPAY (mock)", () => {
  test(
    "chuyển sang cổng, IPN thành công, không tạo đơn hai lần khi reload",
    { tag: "@smoke" },
    async ({ page, request, buyer }) => {
      expect(await countOrdersFor(buyer.email)).toBe(0);
      await guestJourneyToFilledCheckout(page, "vnpay", buyer, (label) =>
        expectNoA11yViolations(page, `VNPAY — ${label}`),
      );

      await page.getByRole("button", { name: "Đặt hàng", exact: true }).click();

      // Chuyển sang cổng VNPAY giả lập với đúng mã giao dịch + số tiền.
      await page.waitForURL(`${URLS.mockVnpay}/pay?**`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("VNPAY");
      const txnRef = (await page.getByTestId("txn-ref").textContent()) ?? "";
      expect(txnRef).not.toBe("");
      await expect(page.getByTestId("amount")).toHaveText(/^[1-9]\d*$/);
      expect(await countOrdersFor(buyer.email)).toBe(1);

      // Khách quay lại cửa hàng khi IPN chưa tới → trang đơn "Đang xác nhận", KHÔNG khẳng định đã thanh toán.
      await page.getByRole("link", { name: "Quay lại cửa hàng" }).click();
      await expect(page).toHaveURL(/\/don-hang\/XS-/);
      const ref = ORDER_REF.exec(new URL(page.url()).pathname)?.[0] ?? "";
      expect(ref).not.toBe("");
      await expect(page.getByText("Đang xác nhận thanh toán")).toBeVisible();
      await expectNoA11yViolations(page, "VNPAY — trang đơn đang xác nhận");
      await expect(page.getByText(/^Đã thanh toán/)).toHaveCount(0);

      // "Kiểm tra lại" khi cổng chưa có kết quả → vẫn chưa xác nhận (trang kết quả vừa kiểm tra một lần nên có thể
      // trả lời "vừa kiểm tra xong, thử lại sau" — giới hạn 1 lần/10 giây; cả hai đều không được khẳng định đã trả).
      await page.getByRole("button", { name: "Kiểm tra lại" }).click();
      await expect(page.getByText(/Chưa có xác nhận thanh toán từ cổng|Bạn vừa kiểm tra xong/)).toBeVisible();
      await expect(page.getByText(/^Đã thanh toán/)).toHaveCount(0);

      // VNPAY gửi IPN thành công (ký bằng mock của packages/domain) → backend xác nhận.
      const ipn = await request.post(`${URLS.mockVnpay}/api/ipn`, { data: { txnRef } });
      expect(ipn.ok()).toBe(true);
      expect(await ipn.json()).toMatchObject({ RspCode: "00" });

      await page.reload();
      await expect(page.getByText(/^Đã thanh toán/)).toBeVisible();
      await expectNoA11yViolations(page, "VNPAY — trang đơn đã thanh toán");
      await expect(page.getByText("Đang xác nhận thanh toán")).toHaveCount(0);

      // IPN gửi lặp → "đã xác nhận" (02), không ghi nhận tiền lần hai.
      const replay = await request.post(`${URLS.mockVnpay}/api/ipn`, { data: { txnRef } });
      expect(await replay.json()).toMatchObject({ RspCode: "02" });

      // Reload trang đơn và trang kết quả (return URL) nhiều lần: vẫn một đơn, cùng mã, vẫn "Đã thanh toán".
      await page.reload();
      await page.goto("/thanh-toan/ket-qua");
      await expect(page).toHaveURL(new RegExp(`/don-hang/${ref}$`));
      await expect(page.getByText(/^Đã thanh toán/)).toBeVisible();
      await page.reload();
      await expect(page.getByText(/^Đã thanh toán/)).toBeVisible();
      expect(await countOrdersFor(buyer.email)).toBe(1);
    },
  );
});
