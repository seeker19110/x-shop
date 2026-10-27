import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MoneyError } from "../money/money.js";
import {
  computeQuote,
  diffQuotes,
  type OrderDiscount,
  type QuoteBreakdown,
  type QuoteInput,
  type ShippingDiscount,
} from "./quote.js";

/** T-134 (D-061): breakdown mang ảnh chụp khuyến mãi tại lúc đặt — loại, giá trị, điều kiện, phạm vi, mã, id. */
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

describe("computeQuote — ảnh chụp khuyến mãi (T-134)", () => {
  it("mã % cấp đơn: chụp id, mã, phạm vi, loại, giá trị, trần, đơn tối thiểu và số thực giảm", () => {
    const q = must({
      ...base,
      orderDiscount: {
        code: "GIAM20",
        promotionId: "promo_1",
        kind: "percent",
        basisPoints: 2000,
        maxAmount: 200_000,
        minSubtotal: 500_000,
      },
    });
    expect(q.orderPromotion).toEqual({
      promotionId: "promo_1",
      code: "GIAM20",
      scope: "order",
      kind: "percent",
      basisPoints: 2000,
      amount: null,
      minSubtotal: 500_000,
      maxAmount: 200_000,
      discountTotal: 200_000,
    });
    expect(q.orderDiscountTotal).toBe(200_000);
    expect(q.shippingPromotion).toBeNull();
  });

  it("không có mã → cả hai ảnh chụp null; id không có → promotionId null, điều kiện vắng → null", () => {
    const none = must(base);
    expect(none.orderPromotion).toBeNull();
    expect(none.shippingPromotion).toBeNull();
    const q = must({ ...base, orderDiscount: { code: "F", kind: "fixed", amount: 50_000 } });
    expect(q.orderPromotion).toEqual({
      promotionId: null,
      code: "F",
      scope: "order",
      kind: "fixed",
      basisPoints: null,
      amount: 50_000,
      minSubtotal: null,
      maxAmount: null,
      discountTotal: 50_000,
    });
  });

  it("ca biên giảm 0: mã 0 % và mã 0 đồng vẫn được chụp, số giảm 0, không phân bổ", () => {
    const pct = must({
      ...base,
      orderDiscount: { code: "Z", promotionId: "p", kind: "percent", basisPoints: 0 },
    });
    expect(pct.orderPromotion).toMatchObject({ kind: "percent", basisPoints: 0, discountTotal: 0 });
    expect(pct.lines.every((l) => l.allocatedDiscount === 0)).toBe(true);
    const fixed = must({ ...base, orderDiscount: { code: "Z0", kind: "fixed", amount: 0 } });
    expect(fixed.orderPromotion).toMatchObject({ kind: "fixed", amount: 0, discountTotal: 0 });
    expect(fixed.total).toBe(1_330_000);
  });

  it("ca biên giảm vượt tổng: giữ giá trị cấu hình, số thực giảm bị kẹp bằng tiền hàng (PRICE04)", () => {
    const q = must({ ...base, orderDiscount: { code: "BIG", kind: "fixed", amount: 9_999_999 } });
    expect(q.orderPromotion).toMatchObject({ amount: 9_999_999, discountTotal: 1_300_000 });
    expect(q.total).toBe(30_000);
  });

  it("mã vận chuyển: phạm vi shipping; free chụp số giảm = phí, phí 0 → giảm 0; fixed vượt phí bị kẹp", () => {
    const free = must({ ...base, shippingDiscount: { code: "FREESHIP", promotionId: "ps", kind: "free" } });
    expect(free.shippingPromotion).toEqual({
      promotionId: "ps",
      code: "FREESHIP",
      scope: "shipping",
      kind: "free",
      basisPoints: null,
      amount: null,
      minSubtotal: null,
      maxAmount: null,
      discountTotal: 30_000,
    });
    expect(free.orderPromotion).toBeNull();
    const zeroFee = must({ ...base, shippingFee: 0, shippingDiscount: { code: "FREESHIP", kind: "free" } });
    expect(zeroFee.shippingPromotion).toMatchObject({ discountTotal: 0 });
    const part = must({ ...base, shippingDiscount: { code: "S", kind: "fixed", amount: 50_000 } });
    expect(part.shippingPromotion).toMatchObject({ kind: "fixed", amount: 50_000, discountTotal: 30_000 });
  });

  it("ảnh chụp là bản sao: sửa đối tượng mã sau khi tính không đổi breakdown đã có", () => {
    const d: OrderDiscount = { code: "GIAM10", promotionId: "p", kind: "percent", basisPoints: 1000 };
    const s: ShippingDiscount = { code: "S", kind: "fixed", amount: 10_000 };
    const q = must({ ...base, orderDiscount: d, shippingDiscount: s });
    const before = structuredClone(q);
    d.basisPoints = 5000;
    d.code = "KHAC";
    s.amount = 99_000;
    expect(q).toEqual(before);
    expect(q.orderPromotion).toMatchObject({ code: "GIAM10", basisPoints: 1000, discountTotal: 130_000 });
  });

  it("lưu dạng JSON (jsonb) rồi đọc lại không mất trường nào (null, không undefined)", () => {
    const q = must({ ...base, orderDiscount: { code: "F", kind: "fixed", amount: 1000 } });
    expect(JSON.parse(JSON.stringify(q))).toEqual(q);
  });

  it("điều kiện sai kiểu (đơn tối thiểu âm/không nguyên) → MoneyError, không áp mã sai", () => {
    for (const minSubtotal of [-1, 1.5, Number.NaN]) {
      expect(() =>
        computeQuote({ ...base, orderDiscount: { code: "M", kind: "fixed", amount: 1, minSubtotal } }),
      ).toThrow(MoneyError);
    }
  });

  it("thuộc tính: số giảm trong ảnh chụp = số giảm của breakdown", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.option(fc.integer({ min: 0, max: 5_000_000 })),
        fc.integer({ min: 0, max: 100_000 }),
        (bp, max, fee) => {
          const q = must({
            ...base,
            shippingFee: fee,
            orderDiscount: {
              code: "C",
              kind: "percent",
              basisPoints: bp,
              ...(max !== null && { maxAmount: max }),
            },
            shippingDiscount: { code: "S", kind: "free" },
          });
          return (
            q.orderPromotion?.discountTotal === q.orderDiscountTotal &&
            q.shippingPromotion?.discountTotal === q.shippingDiscountTotal &&
            q.orderPromotion?.maxAmount === max
          );
        },
      ),
    );
  });
});

describe("diffQuotes — ngữ nghĩa DISCOUNT_CHANGED giữ nguyên (T-134)", () => {
  const pct = (patch: Partial<Extract<OrderDiscount, { kind: "percent" }>> = {}) =>
    must({
      ...base,
      orderDiscount: { code: "G", promotionId: "p1", kind: "percent", basisPoints: 1000, ...patch },
    });
  it("điều khoản đổi mà số giảm và mã như cũ → null (đơn chụp điều khoản lúc đặt)", () => {
    expect(diffQuotes(pct(), pct({ maxAmount: 500_000, promotionId: "p2" }))).toBeNull();
  });
  it("số giảm đổi → DISCOUNT_CHANGED; mã biến mất → DISCOUNT_CHANGED", () => {
    expect(diffQuotes(pct(), pct({ basisPoints: 2000 }))).toBe("DISCOUNT_CHANGED");
    expect(diffQuotes(pct(), must(base))).toBe("DISCOUNT_CHANGED");
  });
  it("quote lưu trước T-134 (không có ảnh chụp) vẫn so được với quote mới", () => {
    const legacy = { ...pct() } as Partial<QuoteBreakdown>;
    delete legacy.orderPromotion;
    delete legacy.shippingPromotion;
    expect(diffQuotes(legacy as QuoteBreakdown, pct())).toBeNull();
  });
});
