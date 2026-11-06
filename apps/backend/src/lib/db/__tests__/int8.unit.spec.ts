import { types } from "@medusajs/framework/pg";
import { INT8_OID, installInt8Parser, parseInt8 } from "../int8";

describe("parseInt8 (T-186)", () => {
  it("chuỗi int8 trong miền an toàn → number", () => {
    expect(parseInt8("0")).toBe(0);
    expect(parseInt8("1330000")).toBe(1_330_000);
    expect(parseInt8("3000000000")).toBe(3_000_000_000);
    expect(parseInt8("-42")).toBe(-42);
    expect(parseInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInt8("-9007199254740991")).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("vượt 2^53 − 1 → RangeError (không làm tròn lặng lẽ)", () => {
    expect(() => parseInt8("9007199254740992")).toThrow(RangeError);
    expect(() => parseInt8("-9007199254740992")).toThrow(RangeError);
    expect(() => parseInt8("9223372036854775807")).toThrow(RangeError);
  });

  it("chuỗi không phải số nguyên (không xảy ra với int8 thật) → RangeError, không thành NaN/0", () => {
    for (const bad of ["", " ", "1.5", "1e3", "0x10", "abc", "NaN", "Infinity", "+1"])
      expect(() => parseInt8(bad)).toThrow(RangeError);
  });
});

describe("installInt8Parser (T-186)", () => {
  it("OID int8 = 20 (pg_type.oid của bigint)", () => {
    expect(INT8_OID).toBe(20);
  });

  it("đăng ký đúng parser cho OID 20 vào registry được truyền", () => {
    const set = jest.fn();
    installInt8Parser({ setTypeParser: set } as never);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(20, parseInt8);
  });

  it("registry mặc định là pg-types của Medusa: sau khi cài, getTypeParser(20) trả number; gọi lại vô hại", () => {
    expect(types.getTypeParser(INT8_OID, "text")("77")).toBe("77");
    installInt8Parser();
    installInt8Parser();
    expect(types.getTypeParser(INT8_OID, "text")("77")).toBe(77);
  });
});
