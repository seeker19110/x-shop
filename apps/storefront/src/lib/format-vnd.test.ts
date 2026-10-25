// @vitest-environment node
import { formatVnd as domainFormatVnd } from "@x-shop/domain";
import { formatVnd } from "./format-vnd";

describe("formatVnd (client) khớp bản domain", () => {
  it.each([0, 1, 999, 1000, 300000, 700000, 1250000, 1300000, 9007199254740991, -5000])("%d", (n) => {
    expect(formatVnd(n)).toBe(domainFormatVnd(n));
  });

  it("định dạng chuẩn vi-VN kèm ₫", () => {
    expect(formatVnd(1250000)).toBe("1.250.000 ₫");
  });

  it("số không nguyên / NaN / vô cực → ném lỗi, giống domain", () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => formatVnd(bad)).toThrow();
      expect(() => domainFormatVnd(bad)).toThrow();
    }
  });
});
