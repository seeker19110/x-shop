import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { guestJourneyToFilledCheckout, placeCodOrder } from "./helpers";

/**
 * T-201 (UX-CONTENT-005 — hủy/rút dễ như đăng ký): số bước người dùng để HỦY đơn ≤ số bước để ĐẶT đơn.
 * "Bước" = một tương tác người dùng (điều hướng bằng URL, bấm, nhập ô, chọn, tick). Đếm bằng cách bọc các phương thức
 * tương tác của Locator/Page trong lúc chạy luồng thật (tái dùng helper đặt hàng, không dựng lại luồng).
 */
const LOCATOR_ACTIONS = ["click", "fill", "selectOption", "check", "press"] as const;

type Counter = { count: number; log: string[] };

/** Bọc tương tác để đếm; trả hàm gỡ bọc. */
function instrument(page: Page, counter: Counter): () => void {
  const proto = Object.getPrototypeOf(page.locator("body")) as Record<string, unknown>;
  const pageProto = Object.getPrototypeOf(page) as Record<string, unknown>;
  const restore: (() => void)[] = [];
  const wrap = (target: Record<string, unknown>, name: string, describe: (self: unknown) => string) => {
    const original = target[name] as (...args: unknown[]) => unknown;
    target[name] = function (this: unknown, ...args: unknown[]) {
      counter.count += 1;
      counter.log.push(`${name} ${describe(this)}`);
      return original.apply(this, args);
    };
    restore.push(() => {
      target[name] = original;
    });
  };
  for (const name of LOCATOR_ACTIONS) wrap(proto, name, (self) => String(self as Locator));
  wrap(pageProto, "goto", () => "(URL)");
  return () => restore.forEach((r) => r());
}

test.describe("T-201 — hủy đơn dễ như đặt đơn", () => {
  test("số bước hủy đơn ≤ số bước đặt đơn", async ({ page, buyer }) => {
    const place: Counter = { count: 0, log: [] };
    const stopPlace = instrument(page, place);
    let ref: string;
    try {
      await guestJourneyToFilledCheckout(page, "cod", buyer);
      ref = await placeCodOrder(page);
    } finally {
      stopPlace();
    }
    await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
    await expect(page.getByText("Đã nhận đơn — chờ xác nhận")).toBeVisible();

    // Hủy từ trang đơn (nơi khách đang đứng sau khi đặt): mở hộp thoại → xác nhận.
    const cancel: Counter = { count: 0, log: [] };
    const stopCancel = instrument(page, cancel);
    try {
      await page.getByRole("button", { name: "Hủy đơn" }).click();
      const dialog = page.getByRole("dialog", { name: `Hủy đơn ${ref}?` });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Xác nhận hủy" }).click();
    } finally {
      stopCancel();
    }
    // Sau khi hủy, trang dựng lại từ server (khối hành động biến mất cùng thông báo tạm) — trạng thái mới là bằng chứng.
    await expect(page.getByText("Bạn đã hủy đơn này.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Hủy đơn" })).toHaveCount(0);

    test
      .info()
      .annotations.push(
        { type: "bước đặt đơn", description: String(place.count) },
        { type: "bước hủy đơn", description: String(cancel.count) },
      );
    expect(cancel.count, `hủy ${cancel.count} bước: ${cancel.log.join(" | ")}`).toBeGreaterThan(0);
    expect(place.count, `đặt ${place.count} bước: ${place.log.join(" | ")}`).toBeGreaterThan(0);
    expect(
      cancel.count,
      `số bước hủy (${cancel.count}) phải ≤ số bước đặt (${place.count}). Đặt: ${place.log.join(" | ")}. Hủy: ${cancel.log.join(" | ")}`,
    ).toBeLessThanOrEqual(place.count);
  });
});
