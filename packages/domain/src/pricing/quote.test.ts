import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeQuote, diffQuotes, type QuoteBreakdown, type QuoteInput } from "./quote.js";

const base: QuoteInput = {
  lines: [
    { lineId: "l1", variantId: "den-m", unitPrice: 700_000, quantity: 1 },
    { lineId: "l2", variantId: "trang-s", unitPrice: 300_000, quantity: 2 },
  ],
  shippingFee: 30_000,
};

function must(input: QuoteInput): QuoteBreakdown {
  const r = computeQuote(input);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}

describe("computeQuote — S-001", () => {
  it("giảm 10% cấp đơn, phân bổ đúng tổng, ship 30.000", () => {
    const q = must({ ...base, orderDiscount: { code: "GIAM10", kind: "percent", basisPoints: 1000 } });
    expect(q.subtotal).toBe(1_300_000);
    expect(q.orderDiscountTotal).toBe(130_000);
    expect(q.lines.map((l) => l.allocatedDiscount)).toEqual([70_000, 60_000]);
    expect(q.lines.map((l) => l.lineTotal)).toEqual([630_000, 540_000]);
    expect(q.shippingTotal).toBe(30_000);
    expect(q.total).toBe(1_200_000);
  });
  it("trần giảm (maxAmount) và điều kiện tối thiểu", () => {
    const q = must({
      ...base,
      orderDiscount: { code: "P", kind: "percent", basisPoints: 5000, maxAmount: 100_000 },
    });
    expect(q.orderDiscountTotal).toBe(100_000);
    const r = computeQuote({
      ...base,
      orderDiscount: { code: "MIN2M", kind: "fixed", amount: 50_000, minSubtotal: 2_000_000 },
    });
    expect(r).toMatchObject({ ok: false, code: "DISCOUNT_NOT_APPLICABLE", field: "discount_code" });
  });
  it("giảm cố định lớn hơn tiền hàng bị kẹp, tổng không âm (PRICE04)", () => {
    const q = must({
      ...base,
      shippingFee: 0,
      orderDiscount: { code: "BIG", kind: "fixed", amount: 9_999_999 },
    });
    expect(q.orderDiscountTotal).toBe(1_300_000);
    expect(q.total).toBe(0);
  });
  it("ưu đãi vận chuyển cộng được với mã đơn", () => {
    const free = must({ ...base, shippingDiscount: { code: "FREESHIP", kind: "free" } });
    expect(free.shippingTotal).toBe(0);
    const part = must({ ...base, shippingDiscount: { code: "SHIP10", kind: "fixed", amount: 50_000 } });
    expect(part.shippingDiscountTotal).toBe(30_000);
    expect(part.total).toBe(1_300_000);
  });
});

describe("computeQuote — ca biên", () => {
  it("giỏ rỗng, quá giới hạn, số lượng/giá sai, dòng trùng", () => {
    expect(computeQuote({ lines: [], shippingFee: 0 })).toMatchObject({ ok: false, code: "CART_EMPTY" });
    const many = Array.from({ length: 51 }, (_, i) => ({
      lineId: `l${i}`,
      variantId: "v",
      unitPrice: 1,
      quantity: 1,
    }));
    expect(computeQuote({ lines: many, shippingFee: 0 })).toMatchObject({ ok: false, code: "LIMIT" });
    const one = (patch: object) => ({
      lines: [{ lineId: "a", variantId: "v", unitPrice: 1000, quantity: 1, ...patch }],
      shippingFee: 0,
    });
    expect(computeQuote(one({ quantity: 0 }))).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(computeQuote(one({ quantity: 100 }))).toMatchObject({ ok: false, code: "LIMIT" });
    expect(computeQuote(one({ quantity: 1.5 }))).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(computeQuote(one({ unitPrice: -1 }))).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(computeQuote(one({ unitPrice: 0.5 }))).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(computeQuote({ ...one({}), shippingFee: -1 })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(computeQuote({ lines: [base.lines[0]!, base.lines[0]!], shippingFee: 0 })).toMatchObject({
      ok: false,
      code: "VALIDATION",
    });
  });
  it("giá 0 đồng (quà tặng) vẫn hợp lệ", () => {
    const q = must({
      lines: [{ lineId: "g", variantId: "gift", unitPrice: 0, quantity: 1 }],
      shippingFee: 0,
      orderDiscount: { code: "X", kind: "percent", basisPoints: 1000 },
    });
    expect(q.total).toBe(0);
    expect(q.lines[0]?.allocatedDiscount).toBe(0);
  });
  it("thuộc tính: bất biến tổng", () => {
    const line = fc.record({
      variantId: fc.string({ minLength: 1, maxLength: 5 }),
      unitPrice: fc.integer({ min: 0, max: 20_000_000 }),
      quantity: fc.integer({ min: 1, max: 99 }),
    });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 50 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.option(fc.integer({ min: 0, max: 10_000 })),
        (ls, ship, bp) => {
          const q = must({
            lines: ls.map((l, i) => ({ ...l, lineId: `l${i}` })),
            shippingFee: ship,
            orderDiscount: bp === null ? undefined : { code: "C", kind: "percent", basisPoints: bp },
          });
          const allocSum = q.lines.reduce((a, l) => a + l.allocatedDiscount, 0);
          const paidSum = q.lines.reduce((a, l) => a + l.lineTotal, 0);
          return (
            allocSum === q.orderDiscountTotal &&
            paidSum === q.subtotal - q.orderDiscountTotal &&
            q.total === paidSum + q.shippingTotal &&
            q.total >= 0 &&
            q.lines.every((l) => l.lineTotal >= 0)
          );
        },
      ),
    );
  });
});

describe("diffQuotes — AT03", () => {
  const q1 = must(base);
  it("giống hệt → null", () => {
    expect(diffQuotes(q1, must(base))).toBeNull();
  });
  it("giá đổi → PRICE_CHANGED", () => {
    const changed = must({ ...base, lines: [{ ...base.lines[0]!, unitPrice: 750_000 }, base.lines[1]!] });
    expect(diffQuotes(q1, changed)).toBe("PRICE_CHANGED");
  });
  it("phí ship đổi → SHIPPING_CHANGED; giảm đổi → DISCOUNT_CHANGED; dòng đổi → CART_CHANGED", () => {
    expect(diffQuotes(q1, must({ ...base, shippingFee: 35_000 }))).toBe("SHIPPING_CHANGED");
    expect(diffQuotes(q1, must({ ...base, orderDiscount: { code: "A", kind: "fixed", amount: 1000 } }))).toBe(
      "DISCOUNT_CHANGED",
    );
    expect(diffQuotes(q1, must({ ...base, lines: [base.lines[0]!] }))).toBe("CART_CHANGED");
  });
  it("giảm phí cũng phải xác nhận lại (không chỉ khi tăng)", () => {
    expect(diffQuotes(q1, must({ ...base, shippingFee: 0 }))).toBe("SHIPPING_CHANGED");
  });
});
