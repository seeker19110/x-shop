import type { MedusaContainer } from "@medusajs/framework/types";
import { warnIfPreviousSecret } from "../payment";

function fakeContainer(warn: (m: string) => void): MedusaContainer {
  return { resolve: () => ({ warn }) } as unknown as MedusaContainer;
}

describe("warnIfPreviousSecret (T-139)", () => {
  it("khoá trước → một cảnh báo có nguồn + mã giao dịch", () => {
    const lines: string[] = [];
    warnIfPreviousSecret(
      fakeContainer((m) => lines.push(m)),
      "previous",
      "ipn",
      "PA01HXYZ",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("vnpay_secret_previous_used");
    expect(lines[0]).toContain("source=ipn");
    expect(lines[0]).toContain("txn_ref=PA01HXYZ");
  });

  it("khoá hiện tại hoặc không xác định → không log", () => {
    const warn = jest.fn();
    warnIfPreviousSecret(fakeContainer(warn), "current", "ipn", "PA1");
    warnIfPreviousSecret(fakeContainer(warn), undefined, "ipn", "PA1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("thiếu/rỗng txn_ref thành '-', cắt độ dài", () => {
    const lines: string[] = [];
    const c = fakeContainer((m) => lines.push(m));
    warnIfPreviousSecret(c, "previous", "ipn", undefined);
    warnIfPreviousSecret(c, "previous", "ipn", "");
    warnIfPreviousSecret(c, "previous", "ipn", "X".repeat(500));
    expect(lines[0]).toContain("txn_ref=- ");
    expect(lines[1]).toContain("txn_ref=- ");
    expect(lines[2]).toContain(`txn_ref=${"X".repeat(64)} `);
  });

  it("logger ném lỗi thì không lan ra", () => {
    expect(() =>
      warnIfPreviousSecret(
        fakeContainer(() => {
          throw new Error("boom");
        }),
        "previous",
        "ipn",
        "PA1",
      ),
    ).not.toThrow();
  });
});
