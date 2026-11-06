import { describe, expect, it } from "vitest";
import { lookupNotice } from "./notices";

describe("lookupNotice", () => {
  it("khoá có trong bảng → thông báo", () => {
    expect(lookupNotice("lien-ket")).toMatch(/hết hạn/);
  });

  it("khoá kế thừa từ prototype → undefined (không trả object)", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"])
      expect(lookupNotice(k)).toBeUndefined();
  });

  it("khoá lạ, rỗng, mảng, thiếu → undefined", () => {
    expect(lookupNotice("khong-co")).toBeUndefined();
    expect(lookupNotice("")).toBeUndefined();
    expect(lookupNotice(["lien-ket"])).toBeUndefined();
    expect(lookupNotice(undefined)).toBeUndefined();
  });
});
