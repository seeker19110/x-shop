import { describe, expect, it } from "vitest";
import {
  computeQuote,
  type OrderDiscount,
  type QuoteBreakdown,
  type QuoteInput,
  type ShippingDiscount,
} from "./quote.js";

/**
 * IND-ECOM-004 — bảng ca chồng mã (%, tiền, freeship). Phạm vi = hành vi ĐANG CÓ của `computeQuote`: tối đa MỘT mã cấp
 * đơn (percent|fixed) + tối đa MỘT ưu đãi ship (free|fixed), hai loại cộng được với nhau. Giới hạn/người, ngân sách và
 * chồng nhiều mã cấp đơn CHƯA có trong đặc tả/code → xem câu hỏi mở ở docs/specs/SPEC-checkout.md §5.
 */
const lines: QuoteInput["lines"] = [
  { lineId: "l1", variantId: "den-m", unitPrice: 700_000, quantity: 1 },
  { lineId: "l2", variantId: "trang-s", unitPrice: 300_000, quantity: 2 },
]; // subtotal 1.300.000
const SHIP = 30_000;

function quote(orderDiscount?: OrderDiscount, shippingDiscount?: ShippingDiscount, shippingFee = SHIP) {
  const r = computeQuote({ lines, shippingFee, orderDiscount, shippingDiscount });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}

function invariants(q: QuoteBreakdown) {
  for (const n of [
    q.subtotal,
    q.orderDiscountTotal,
    q.shippingDiscountTotal,
    q.shippingTotal,
    q.total,
    ...q.lines.flatMap((l) => [l.lineSubtotal, l.allocatedDiscount, l.lineTotal]),
  ]) {
    expect(Number.isSafeInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
  }
  expect(q.lines.reduce((a, l) => a + l.allocatedDiscount, 0)).toBe(q.orderDiscountTotal);
  expect(q.orderDiscountTotal).toBeLessThanOrEqual(q.subtotal);
  expect(q.shippingDiscountTotal).toBeLessThanOrEqual(q.shippingFee);
  expect(q.total).toBe(q.subtotal - q.orderDiscountTotal + q.shippingFee - q.shippingDiscountTotal);
}

const pct = (
  basisPoints: number,
  extra: { maxAmount?: number; minSubtotal?: number } = {},
): OrderDiscount => ({
  code: "PCT",
  kind: "percent",
  basisPoints,
  ...extra,
});
const fixed = (amount: number, minSubtotal?: number): OrderDiscount => ({
  code: "FIX",
  kind: "fixed",
  amount,
  ...(minSubtotal === undefined ? {} : { minSubtotal }),
});
const FREE: ShippingDiscount = { code: "FREESHIP", kind: "free" };
const shipFixed = (amount: number): ShippingDiscount => ({ code: "SHIP-FIX", kind: "fixed", amount });

interface Case {
  name: string;
  order?: OrderDiscount;
  ship?: ShippingDiscount;
  fee?: number;
  /** [orderDiscountTotal, shippingDiscountTotal, total] */
  want: [number, number, number];
}

const TABLE: Case[] = [
  { name: "không mã", want: [0, 0, 1_330_000] },
  { name: "% đơn 10%", order: pct(1000), want: [130_000, 0, 1_200_000] },
  { name: "% đơn 10% có trần 50.000", order: pct(1000, { maxAmount: 50_000 }), want: [50_000, 0, 1_280_000] },
  { name: "% làm tròn xuống (33,33%)", order: pct(3333), want: [433_290, 0, 896_710] },
  { name: "% 0 bp = không giảm", order: pct(0), want: [0, 0, 1_330_000] },
  { name: "% 100% kẹp bằng subtotal, còn phí ship", order: pct(10_000), want: [1_300_000, 0, 30_000] },
  { name: "tiền cố định 200.000", order: fixed(200_000), want: [200_000, 0, 1_130_000] },
  { name: "tiền cố định > subtotal bị kẹp", order: fixed(5_000_000), want: [1_300_000, 0, 30_000] },
  { name: "tiền cố định 0", order: fixed(0), want: [0, 0, 1_330_000] },
  { name: "freeship một mình", ship: FREE, want: [0, 30_000, 1_300_000] },
  { name: "freeship khi phí ship 0", ship: FREE, fee: 0, want: [0, 0, 1_300_000] },
  { name: "ship cố định 10.000", ship: shipFixed(10_000), want: [0, 10_000, 1_320_000] },
  { name: "ship cố định > phí ship bị kẹp", ship: shipFixed(99_000), want: [0, 30_000, 1_300_000] },
  { name: "% + freeship (chồng được)", order: pct(1000), ship: FREE, want: [130_000, 30_000, 1_170_000] },
  {
    name: "tiền + ship cố định (chồng được)",
    order: fixed(200_000),
    ship: shipFixed(10_000),
    want: [200_000, 10_000, 1_120_000],
  },
  {
    name: "giảm kẹp tối đa + freeship: tổng chỉ còn 0",
    order: fixed(9_999_999),
    ship: FREE,
    want: [1_300_000, 30_000, 0],
  },
];

describe("IND-ECOM-004 — bảng chồng mã cấp đơn + ship", () => {
  it.each(TABLE)("$name", ({ order, ship, fee, want }) => {
    const q = quote(order, ship, fee);
    expect([q.orderDiscountTotal, q.shippingDiscountTotal, q.total]).toEqual(want);
    invariants(q);
  });

  it("thứ tự áp: giảm cấp đơn tính trên subtotal TRƯỚC giảm, không tính trên phí ship; ship tách riêng", () => {
    const withShipPromo = quote(pct(1000), FREE);
    const without = quote(pct(1000));
    expect(withShipPromo.orderDiscountTotal).toBe(without.orderDiscountTotal); // 10% × 1.300.000, độc lập ship
    expect(withShipPromo.shippingDiscountTotal).toBe(SHIP); // freeship độc lập mã đơn
    expect(withShipPromo.lines.map((l) => l.lineTotal)).toEqual(without.lines.map((l) => l.lineTotal));
  });

  it("giới hạn chồng: breakdown ghi đúng một mã đơn + một mã ship, mã khác loại không đè nhau", () => {
    const q = quote(pct(1000), FREE);
    expect(q.orderDiscountCode).toBe("PCT");
    expect(q.shippingDiscountCode).toBe("FREESHIP");
    expect(quote(undefined, FREE).orderDiscountCode).toBeNull();
    expect(quote(pct(1000)).shippingDiscountCode).toBeNull();
  });

  it("điều kiện đơn tối thiểu: biên đúng bằng ngưỡng được áp, thiếu 1 đồng bị từ chối", () => {
    expect(quote(fixed(100_000, 1_300_000)).orderDiscountTotal).toBe(100_000);
    const r = computeQuote({ lines, shippingFee: SHIP, orderDiscount: fixed(100_000, 1_300_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DISCOUNT_NOT_APPLICABLE");
  });

  it("mã không hợp lệ về kiểu số (không nguyên/âm/vượt 100%) → ném lỗi, không làm tròn lặng lẽ", () => {
    expect(() => quote(pct(10_001))).toThrow();
    expect(() => quote(pct(12.5))).toThrow();
    expect(() => quote(fixed(-1))).toThrow();
    expect(() => quote(fixed(1.5))).toThrow();
    expect(() => quote(undefined, shipFixed(-1))).toThrow();
    expect(() => quote(pct(1000, { maxAmount: 0.5 }))).toThrow();
  });

  it("đơn giá lớn: giảm % vẫn là số nguyên an toàn, không tràn 2^53", () => {
    const big = computeQuote({
      lines: [{ lineId: "x", variantId: "v", unitPrice: 4_000_000_000, quantity: 99 }],
      shippingFee: 0,
      orderDiscount: pct(3333),
    });
    expect(big.ok).toBe(true);
    if (big.ok) invariants(big.value);
  });

  it("quà tặng 0 đồng + mã tiền: giảm kẹp về 0, tổng không âm", () => {
    const r = computeQuote({
      lines: [{ lineId: "g", variantId: "qua", unitPrice: 0, quantity: 1 }],
      shippingFee: SHIP,
      orderDiscount: fixed(50_000),
      shippingDiscount: FREE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.orderDiscountTotal).toBe(0);
      expect(r.value.total).toBe(0);
      invariants(r.value);
    }
  });
});
