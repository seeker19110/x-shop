import { describe, expect, it } from "vitest";
import { err, ok } from "./result.js";

describe("Result", () => {
  it("ok mang giá trị", () => {
    expect(ok(0)).toEqual({ ok: true, value: 0 });
  });
  it("err giữ mã, thông báo, trường gây lỗi", () => {
    expect(err("VALIDATION", "Thiếu số điện thoại", "phone")).toEqual({
      ok: false,
      code: "VALIDATION",
      message: "Thiếu số điện thoại",
      field: "phone",
    });
    expect(err("X", "m")).not.toHaveProperty("field");
  });
});
