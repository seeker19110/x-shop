import { describe, expect, it } from "vitest";
import { isNonEmpty } from "./presence.js";

describe("isNonEmpty (BASE-DATA-003)", () => {
  it("thiếu (null/undefined) và chuỗi rỗng → false", () => {
    expect(isNonEmpty(null)).toBe(false);
    expect(isNonEmpty(undefined)).toBe(false);
    expect(isNonEmpty("")).toBe(false);
  });
  it('chuỗi có nội dung (kể cả khoảng trắng, "0", "false") và Date → true', () => {
    expect(isNonEmpty(" ")).toBe(true);
    expect(isNonEmpty("0")).toBe(true);
    expect(isNonEmpty("false")).toBe(true);
    expect(isNonEmpty(new Date(0))).toBe(true);
  });
  it("thu hẹp kiểu về chuỗi", () => {
    const v: string | null = "id_1" as string | null;
    expect(isNonEmpty(v) ? v.length : -1).toBe(4);
  });
});
