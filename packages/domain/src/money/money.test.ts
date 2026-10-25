import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MoneyError,
  allocateVnd,
  assertVnd,
  formatVnd,
  multiplyVnd,
  percentOfVnd,
  refundForUnits,
  sumVnd,
  unitShares,
} from "./money.js";

describe("assertVnd / sumVnd / multiplyVnd", () => {
  it("từ chối số thực, NaN, vô cực, vượt an toàn", () => {
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => assertVnd(bad)).toThrow(MoneyError);
    }
    expect(assertVnd(0)).toBe(0);
    expect(assertVnd(-5)).toBe(-5);
  });
  it("cộng và nhân nguyên", () => {
    expect(sumVnd([])).toBe(0);
    expect(sumVnd([700_000, 300_000, 300_000])).toBe(1_300_000);
    expect(multiplyVnd(300_000, 2)).toBe(600_000);
    expect(() => multiplyVnd(300_000, 1.5)).toThrow(MoneyError);
    expect(() => sumVnd([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError);
  });
});

describe("percentOfVnd", () => {
  it("10% của 1.300.000 = 130.000; làm tròn xuống", () => {
    expect(percentOfVnd(1_300_000, 1000)).toBe(130_000);
    expect(percentOfVnd(99_999, 1000)).toBe(9_999);
    expect(percentOfVnd(0, 1000)).toBe(0);
    expect(percentOfVnd(123, 10_000)).toBe(123);
  });
  it("biên basis point", () => {
    expect(() => percentOfVnd(100, -1)).toThrow(MoneyError);
    expect(() => percentOfVnd(100, 10_001)).toThrow(MoneyError);
    expect(() => percentOfVnd(-100, 100)).toThrow(MoneyError);
  });
  it("không vượt tỷ lệ với số rất lớn", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.integer({ min: 0, max: 10_000 }),
        (a, bp) => {
          const p = percentOfVnd(a, bp);
          return Number.isSafeInteger(p) && p >= 0 && p <= a;
        },
      ),
    );
  });
});

describe("allocateVnd (largest remainder)", () => {
  it("ví dụ đặc tả: giảm 100.000 cho 700.000 + 300.000 → 70.000 + 30.000", () => {
    expect(allocateVnd(100_000, [700_000, 300_000])).toEqual([70_000, 30_000]);
  });
  it("phần dư chia theo phần dư lớn nhất, hòa → dòng trước", () => {
    expect(allocateVnd(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateVnd(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateVnd(10, [3, 0, 7])).toEqual([3, 0, 7]);
  });
  it("ca biên rỗng/0", () => {
    expect(allocateVnd(0, [])).toEqual([]);
    expect(allocateVnd(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocateVnd(1, [])).toThrow(MoneyError);
    expect(() => allocateVnd(1, [0, 0])).toThrow(MoneyError);
    expect(() => allocateVnd(-1, [1])).toThrow(MoneyError);
    expect(() => allocateVnd(1, [-1, 2])).toThrow(MoneyError);
  });
  it("thuộc tính: tổng đúng tuyệt đối, không âm, lệch tỷ lệ < 1 đồng", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 1, maxLength: 50 }),
        (total, weights) => {
          const W = weights.reduce((a, b) => a + b, 0);
          if (W === 0) return true;
          const parts = allocateVnd(total, weights);
          if (parts.reduce((a, b) => a + b, 0) !== total) return false;
          return parts.every((p, i) => {
            const exact = (total * (weights[i] as number)) / W;
            return p >= 0 && Math.abs(p - exact) < 1 + 1e-6;
          });
        },
      ),
    );
  });
  it("tất định: cùng đầu vào cùng kết quả", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 20 }),
        (t, w) => JSON.stringify(allocateVnd(t, w)) === JSON.stringify(allocateVnd(t, w)),
      ),
    );
  });
});

describe("unitShares / refundForUnits", () => {
  it("dòng 3 đơn vị trả 100.000 → 33.334 + 33.333 + 33.333", () => {
    expect(unitShares(100_000, 3)).toEqual([33_334, 33_333, 33_333]);
  });
  it("nhiều lần trả một phần cộng lại đúng tổng dòng", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 20 }),
        (lineTotal, qty, chunks) => {
          let returned = 0;
          let refunded = 0;
          for (const c of chunks) {
            const k = Math.min(c, qty - returned);
            if (k <= 0) break;
            refunded += refundForUnits(lineTotal, qty, returned, k);
            returned += k;
          }
          if (returned === qty) return refunded === lineTotal;
          return refunded <= lineTotal;
        },
      ),
    );
  });
  it("chặn trả vượt số lượng và đầu vào sai", () => {
    expect(() => refundForUnits(100, 2, 1, 2)).toThrow(MoneyError);
    expect(() => refundForUnits(100, 2, -1, 1)).toThrow(MoneyError);
    expect(() => refundForUnits(100, 2, 0, 0)).toThrow(MoneyError);
    expect(() => unitShares(100, 0)).toThrow(MoneyError);
  });
});

describe("formatVnd", () => {
  it("định dạng vi-VN", () => {
    expect(formatVnd(1_300_000).replace(/\s/g, " ")).toBe("1.300.000 ₫");
  });
});
