import { err, ok, type Result } from "../result.js";
import { allocateVnd, assertNonNegativeVnd, multiplyVnd, percentOfVnd, sumVnd } from "../money/money.js";

export const MAX_LINES = 50;
export const MAX_QUANTITY_PER_LINE = 99;

export interface QuoteLineInput {
  lineId: string;
  variantId: string;
  /** Giá bán hiện hành do backend đọc từ price list (PRICE01) — không lấy từ client. */
  unitPrice: number;
  quantity: number;
}

/** Ưu đãi cấp đơn: P0 tối đa MỘT mã (PRICE02). */
export type OrderDiscount =
  | { code: string; kind: "percent"; basisPoints: number; maxAmount?: number; minSubtotal?: number }
  | { code: string; kind: "fixed"; amount: number; minSubtotal?: number };

/** Ưu đãi vận chuyển có thể cộng với mã cấp đơn nếu được cấu hình. */
export type ShippingDiscount =
  { code: string; kind: "free" } | { code: string; kind: "fixed"; amount: number };

export interface QuoteInput {
  lines: readonly QuoteLineInput[];
  shippingFee: number;
  orderDiscount?: OrderDiscount | undefined;
  shippingDiscount?: ShippingDiscount | undefined;
}

export interface QuoteLine extends QuoteLineInput {
  /** unitPrice × quantity */
  lineSubtotal: number;
  /** Phần giảm cấp đơn phân bổ về dòng (PRICE03). */
  allocatedDiscount: number;
  /** Số khách thực trả cho dòng = lineSubtotal − allocatedDiscount; căn cứ hoàn tiền. */
  lineTotal: number;
}

export interface QuoteBreakdown {
  lines: QuoteLine[];
  subtotal: number;
  orderDiscountTotal: number;
  orderDiscountCode: string | null;
  shippingFee: number;
  shippingDiscountTotal: number;
  shippingDiscountCode: string | null;
  shippingTotal: number;
  total: number;
}

export type QuoteError = "CART_EMPTY" | "LIMIT" | "VALIDATION" | "DISCOUNT_NOT_APPLICABLE";

function orderDiscountAmount(d: OrderDiscount, subtotal: number): Result<number, QuoteError> {
  if (d.minSubtotal !== undefined && subtotal < d.minSubtotal) {
    return err("DISCOUNT_NOT_APPLICABLE", `Mã ${d.code} cần đơn từ ${d.minSubtotal} đồng`, "discount_code");
  }
  let amount: number;
  if (d.kind === "percent") {
    amount = percentOfVnd(subtotal, d.basisPoints);
    if (d.maxAmount !== undefined) amount = Math.min(amount, assertNonNegativeVnd(d.maxAmount, "maxAmount"));
  } else {
    amount = assertNonNegativeVnd(d.amount, "discount.amount");
  }
  // PRICE04: giảm không vượt tiền hàng; tổng không âm.
  return ok(Math.min(amount, subtotal));
}

/**
 * Báo giá do server tính (CHK04, PRICE01–04). Hàm thuần: cùng đầu vào → cùng breakdown, mọi số là nguyên VND.
 * Bất biến: Σ allocatedDiscount = orderDiscountTotal; Σ lineTotal = subtotal − orderDiscountTotal; total ≥ 0.
 */
export function computeQuote(input: QuoteInput): Result<QuoteBreakdown, QuoteError> {
  const { lines } = input;
  if (lines.length === 0) return err("CART_EMPTY", "Giỏ hàng đang trống");
  if (lines.length > MAX_LINES) return err("LIMIT", `Giỏ tối đa ${MAX_LINES} dòng`);
  const ids = new Set<string>();
  for (const l of lines) {
    if (ids.has(l.lineId)) return err("VALIDATION", `Dòng ${l.lineId} bị trùng`, "lines");
    ids.add(l.lineId);
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) {
      return err("VALIDATION", "Số lượng phải từ 1", `lines.${l.lineId}.quantity`);
    }
    if (l.quantity > MAX_QUANTITY_PER_LINE) {
      return err("LIMIT", `Mỗi dòng tối đa ${MAX_QUANTITY_PER_LINE} sản phẩm`, `lines.${l.lineId}.quantity`);
    }
    if (!Number.isSafeInteger(l.unitPrice) || l.unitPrice < 0) {
      return err("VALIDATION", "Giá không hợp lệ", `lines.${l.lineId}.unitPrice`);
    }
  }
  if (!Number.isSafeInteger(input.shippingFee) || input.shippingFee < 0) {
    return err("VALIDATION", "Phí vận chuyển không hợp lệ", "shipping");
  }

  const lineSubtotals = lines.map((l) => multiplyVnd(l.unitPrice, l.quantity));
  const subtotal = sumVnd(lineSubtotals);

  let orderDiscountTotal = 0;
  if (input.orderDiscount) {
    const d = orderDiscountAmount(input.orderDiscount, subtotal);
    if (!d.ok) return d;
    orderDiscountTotal = d.value;
  }
  const allocated = allocateVnd(orderDiscountTotal, lineSubtotals);

  let shippingDiscountTotal = 0;
  const sd = input.shippingDiscount;
  if (sd) {
    shippingDiscountTotal =
      sd.kind === "free" ? input.shippingFee : Math.min(assertNonNegativeVnd(sd.amount), input.shippingFee);
  }
  const shippingTotal = input.shippingFee - shippingDiscountTotal;

  const quoteLines: QuoteLine[] = lines.map((l, i) => {
    const lineSubtotal = lineSubtotals[i] as number;
    const allocatedDiscount = allocated[i] as number;
    return { ...l, lineSubtotal, allocatedDiscount, lineTotal: lineSubtotal - allocatedDiscount };
  });

  return ok({
    lines: quoteLines,
    subtotal,
    orderDiscountTotal,
    orderDiscountCode: input.orderDiscount?.code ?? null,
    shippingFee: input.shippingFee,
    shippingDiscountTotal,
    shippingDiscountCode: sd?.code ?? null,
    shippingTotal,
    total: subtotal - orderDiscountTotal + shippingTotal,
  });
}

export type QuoteChange = "PRICE_CHANGED" | "SHIPPING_CHANGED" | "DISCOUNT_CHANGED" | "CART_CHANGED";

/**
 * So quote khách đã xác nhận với quote tính lại lúc submit (AT03). Mọi khác biệt về dòng, giá, phí hay giảm → phải
 * xác nhận lại; không thu thêm ngầm. Trả về null khi giống hệt.
 */
export function diffQuotes(confirmed: QuoteBreakdown, current: QuoteBreakdown): QuoteChange | null {
  const key = (q: QuoteBreakdown) =>
    q.lines
      .map((l) => `${l.lineId}|${l.variantId}|${l.quantity}`)
      .sort()
      .join(",");
  if (key(confirmed) !== key(current)) return "CART_CHANGED";
  const price = (q: QuoteBreakdown) =>
    q.lines
      .map((l) => `${l.lineId}|${l.unitPrice}`)
      .sort()
      .join(",");
  if (price(confirmed) !== price(current)) return "PRICE_CHANGED";
  if (
    confirmed.orderDiscountTotal !== current.orderDiscountTotal ||
    confirmed.orderDiscountCode !== current.orderDiscountCode ||
    confirmed.shippingDiscountTotal !== current.shippingDiscountTotal
  ) {
    return "DISCOUNT_CHANGED";
  }
  if (confirmed.shippingFee !== current.shippingFee) return "SHIPPING_CHANGED";
  return confirmed.total === current.total ? null : "PRICE_CHANGED";
}
