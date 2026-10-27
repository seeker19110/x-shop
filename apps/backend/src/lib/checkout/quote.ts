import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  computeQuote,
  type AddressSnapshot,
  type OrderDiscount,
  type QuoteBreakdown,
  type ShippingDiscount,
  isNonEmpty,
  reusableShippingFee,
} from "@x-shop/domain";
import type { CheckoutCart } from "./cart";
import { toSafeInteger } from "./cart";
import { MAX_MONEY_VND } from "./config";
import { CheckoutError } from "./errors";
import { quoteShippingFee, shippingFeeBasis, type ShippingFeeQuote } from "../shipping/rates";
import { cartWeightGrams } from "./shipping";

/**
 * Báo giá do server tính (S-001, PRICE01): giá HIỆN HÀNH đọc trực tiếp Pricing Module (không cache, không nhận giá từ
 * client, không dùng unit_price đã lưu trong giỏ), mã giảm đọc Promotion Module, phí ship báo từ GHN (`quoteShippingFee`,
 * có hạn, lưu cùng quote để submit dùng lại — `reusableShippingFee`); số học tiền nằm trọn trong `computeQuote` của domain.
 */
export interface LoadedDiscount {
  code: string;
  promotion_id: string;
  /** Hạn mức lượt dùng (Promotion.limit); null = không giới hạn. */
  limit: number | null;
  orderDiscount?: OrderDiscount;
  shippingDiscount?: ShippingDiscount;
}

export interface BuiltQuote {
  breakdown: QuoteBreakdown;
  discount: LoadedDiscount | null;
  shipping: ShippingFeeQuote;
}

/** Dòng không bán được (biến thể mất/ẩn/không có giá) → 409 CART_CHANGED kèm danh sách (S-010). */
function assertLinesSellable(cart: CheckoutCart, prices: Map<string, number>): void {
  const unavailable = cart.items
    .filter((l) => !isNonEmpty(l.variant_id) || !l.product_published || !prices.has(l.variant_id))
    .map((l) => ({ line_item_id: l.id, variant_id: l.variant_id, reason: "unavailable" }));
  if (unavailable.length > 0) {
    throw new CheckoutError(
      "CART_CHANGED",
      "Một số sản phẩm trong giỏ không còn bán, vui lòng cập nhật giỏ",
      {
        detail: { lines: unavailable },
      },
    );
  }
}

/** Giá bán hiện hành theo region/tiền tệ của giỏ — đọc thẳng Pricing Module (không qua cache truy vấn). */
export async function currentUnitPrices(
  container: MedusaContainer,
  cart: CheckoutCart,
): Promise<Map<string, number>> {
  const variantIds = [
    ...new Set(cart.items.flatMap((l) => (isNonEmpty(l.variant_id) ? [l.variant_id] : []))),
  ];
  const prices = new Map<string, number>();
  if (variantIds.length === 0) return prices;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "variant",
    fields: ["id", "price_set.id"],
    filters: { id: variantIds },
  });
  const variantToSet = new Map<string, string>();
  for (const v of data as Array<{ id: string; price_set?: { id?: string } | null }>) {
    if (v.price_set && isNonEmpty(v.price_set.id)) variantToSet.set(v.id, v.price_set.id);
  }
  if (variantToSet.size === 0) return prices;
  const pricing = container.resolve(Modules.PRICING);
  const context: Record<string, string> = { currency_code: cart.currency_code };
  if (isNonEmpty(cart.region_id)) context.region_id = cart.region_id;
  if (isNonEmpty(cart.customer_id)) context.customer_id = cart.customer_id;
  const calculated = await pricing.calculatePrices({ id: [...new Set(variantToSet.values())] }, { context });
  const bySet = new Map(calculated.map((c) => [c.id, c]));
  for (const [variantId, setId] of variantToSet) {
    const c = bySet.get(setId);
    if (!c || c.calculated_amount === null || c.calculated_amount === undefined) continue;
    const amount = toSafeInteger(c.calculated_amount);
    if (amount === null || amount < 0) {
      // Giá VND phải là số nguyên đồng (ISO 4217 exponent 0) — cấu hình sai là lỗi hệ thống, không làm tròn ngầm.
      throw new CheckoutError("INTERNAL", "Giá sản phẩm cấu hình sai (không phải số nguyên đồng)", {
        detail: { variant_id: variantId },
      });
    }
    prices.set(variantId, amount);
  }
  return prices;
}

interface RawPromotion {
  id: string;
  code: string;
  status?: string | null;
  type?: string | null;
  is_automatic?: boolean | null;
  limit?: number | null;
  campaign?: { starts_at?: string | Date | null; ends_at?: string | Date | null } | null;
  rules?: unknown[] | null;
  application_method?: {
    type?: string | null;
    target_type?: string | null;
    value?: unknown;
    currency_code?: string | null;
  } | null;
}

const notApplicable = (message = "Mã giảm giá không tồn tại hoặc đã hết hạn") =>
  new CheckoutError("DISCOUNT_NOT_APPLICABLE", message, { field: "discount_code" });

/** Chuẩn hóa mã do khách nhập: bỏ khoảng trắng, chữ hoa (Promotion code của Medusa so khớp chính xác). */
export function normalizeDiscountCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const code = raw.trim().toUpperCase();
  return code === "" ? null : code;
}

/**
 * Đọc mã giảm P0 (PRICE02: tối đa MỘT mã): chỉ mã `standard` đang `active`, trong thời gian chiến dịch, không có điều
 * kiện (rules) — điều kiện phức tạp chưa hỗ trợ thì từ chối rõ ràng thay vì áp sai.
 */
export async function loadDiscount(
  container: MedusaContainer,
  code: string,
  currencyCode: string,
  now: Date,
): Promise<LoadedDiscount> {
  const promotionModule = container.resolve(Modules.PROMOTION);
  const found = (await promotionModule.listPromotions(
    { code },
    { relations: ["application_method", "campaign", "rules"] },
  )) as unknown as RawPromotion[];
  const p = found.find((x) => x.code.toUpperCase() === code);
  if (!p || p.status !== "active" || p.type !== "standard" || p.is_automatic === true) throw notApplicable();
  const startsAt = p.campaign && isNonEmpty(p.campaign.starts_at) ? new Date(p.campaign.starts_at) : null;
  const endsAt = p.campaign && isNonEmpty(p.campaign.ends_at) ? new Date(p.campaign.ends_at) : null;
  // Biên thời gian (DATA04): now >= ends_at là hết hạn.
  if ((startsAt && now < startsAt) || (endsAt && now >= endsAt)) throw notApplicable();
  if ((p.rules ?? []).length > 0) throw notApplicable("Mã giảm giá có điều kiện chưa được hỗ trợ");
  const am = p.application_method;
  const value = toNumberValue(am?.value);
  if (!am || value === null || value < 0) throw notApplicable();
  const limit = p.limit === null || p.limit === undefined ? null : toSafeInteger(p.limit);
  const base = { code, promotion_id: p.id, limit };
  if (am.type === "fixed" && (am.currency_code ?? "").toLowerCase() !== currencyCode) throw notApplicable();
  if (am.target_type === "order") {
    if (am.type === "percentage") {
      const basisPoints = Math.round(value * 100);
      if (basisPoints > 10_000 || Math.abs(basisPoints - value * 100) > 1e-9) throw notApplicable();
      return { ...base, orderDiscount: { code, kind: "percent", basisPoints } };
    }
    if (am.type === "fixed" && Number.isSafeInteger(value)) {
      return { ...base, orderDiscount: { code, kind: "fixed", amount: value } };
    }
  }
  if (am.target_type === "shipping_methods") {
    if (am.type === "percentage" && value === 100)
      return { ...base, shippingDiscount: { code, kind: "free" } };
    if (am.type === "fixed" && Number.isSafeInteger(value)) {
      return { ...base, shippingDiscount: { code, kind: "fixed", amount: value } };
    }
  }
  throw notApplicable("Loại mã giảm giá này chưa được hỗ trợ");
}

function toNumberValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v)) ? Number(v) : null;
  if (typeof v === "object" && v !== null && "numeric" in v)
    return toNumberValue((v as { numeric: unknown }).numeric);
  return null;
}

const QUOTE_ERROR_MESSAGES: Record<string, string> = {
  CART_EMPTY: "Giỏ hàng đang trống",
  LIMIT: "Giỏ hàng vượt giới hạn cho phép",
};

/** Quote đã lưu (`checkout_quote`) mà submit đối chiếu — nguồn của phí ship đã báo. */
export interface StoredQuoteShipping {
  shipping?: unknown;
  breakdown: unknown;
  payment_method: string;
  expires_at: Date | string;
}

/**
 * Tính báo giá đầy đủ cho giỏ + địa chỉ + mã (không ghi gì). `reuse` (chỉ submit): quote khách đã xác nhận + phương thức
 * thanh toán lúc submit — phí ship lấy từ quote nếu còn dùng được, ngược lại hỏi hãng như lúc quote.
 */
export async function buildQuote(
  container: MedusaContainer,
  cart: CheckoutCart,
  address: AddressSnapshot,
  discountCode: string | null,
  now: Date,
  reuse?: { quote: StoredQuoteShipping; paymentMethod: string },
): Promise<BuiltQuote> {
  if (cart.items.length === 0) throw new CheckoutError("CART_EMPTY");
  const prices = await currentUnitPrices(container, cart);
  assertLinesSellable(cart, prices);
  // Mã rỗng = không áp mã (giữ hành vi cũ).
  const discount = isNonEmpty(discountCode)
    ? await loadDiscount(container, discountCode, cart.currency_code, now)
    : null;
  const goodsValue = cart.items.reduce(
    (sum, l) => sum + (prices.get(l.variant_id as string) as number) * l.quantity,
    0,
  );
  const weightGrams = cartWeightGrams(
    cart.items.map((l) => ({ weightGrams: l.weight_grams, quantity: l.quantity })),
  );
  const insuranceValue = Number.isSafeInteger(goodsValue)
    ? Math.min(goodsValue, MAX_MONEY_VND)
    : MAX_MONEY_VND;
  // Submit: phí đã báo trong quote còn hạn + đầu vào định phí không đổi → dùng lại, không hỏi lại hãng (T-153).
  const reused = reuse
    ? reusableShippingFee(
        {
          snapshot: reuse.quote.shipping,
          shippingFee: (reuse.quote.breakdown as { shippingFee?: unknown } | null)?.shippingFee,
          paymentMethod: reuse.quote.payment_method,
          expiresAt: reuse.quote.expires_at,
        },
        { ...shippingFeeBasis(address, weightGrams, insuranceValue), paymentMethod: reuse.paymentMethod },
        now,
      )
    : null;
  const shipping: ShippingFeeQuote =
    reused !== null && reused.provider === "ghn"
      ? { ...reused, provider: "ghn" }
      : await quoteShippingFee(address, weightGrams, insuranceValue, now);
  const result = computeQuote({
    lines: cart.items.map((l) => ({
      lineId: l.id,
      variantId: l.variant_id as string,
      unitPrice: prices.get(l.variant_id as string) as number,
      quantity: l.quantity,
    })),
    shippingFee: shipping.fee,
    orderDiscount: discount?.orderDiscount,
    shippingDiscount: discount?.shippingDiscount,
  });
  if (!result.ok) {
    const code = result.code === "DISCOUNT_NOT_APPLICABLE" ? "DISCOUNT_NOT_APPLICABLE" : result.code;
    throw new CheckoutError(code, QUOTE_ERROR_MESSAGES[result.code] ?? result.message, {
      ...(result.field !== undefined && { field: result.field }),
    });
  }
  const b = result.value;
  if (b.subtotal > MAX_MONEY_VND || b.total > MAX_MONEY_VND) {
    throw new CheckoutError("LIMIT", "Giá trị đơn vượt mức tối đa cho phép, vui lòng chia thành nhiều đơn");
  }
  return { breakdown: b, discount, shipping };
}

/** Hình quote trả cho client (tiền số nguyên VND, thời gian ISO 8601 UTC). */
export function presentQuote(q: {
  id: string;
  cart_id: string;
  cart_version: number;
  payment_method: string;
  discount_code: string | null;
  expires_at: Date | string;
  breakdown: QuoteBreakdown;
  address: AddressSnapshot;
  /** Báo phí của hãng (thời điểm + hạn) — chỉ có khi vừa hỏi hãng. */
  shipping?: ShippingFeeQuote;
}) {
  const b = q.breakdown;
  return {
    id: q.id,
    cart_id: q.cart_id,
    cart_version: q.cart_version,
    payment_method: q.payment_method,
    discount_code: q.discount_code,
    expires_at: new Date(q.expires_at).toISOString(),
    currency_code: "vnd",
    lines: b.lines.map((l) => ({
      line_item_id: l.lineId,
      variant_id: l.variantId,
      unit_price: l.unitPrice,
      quantity: l.quantity,
      subtotal: l.lineSubtotal,
      discount: l.allocatedDiscount,
      total: l.lineTotal,
    })),
    subtotal: b.subtotal,
    discount_total: b.orderDiscountTotal,
    shipping_fee: b.shippingFee,
    shipping_discount: b.shippingDiscountTotal,
    shipping_total: b.shippingTotal,
    total: b.total,
    address: q.address,
    ...(q.shipping && {
      shipping_quote: {
        provider: q.shipping.provider,
        service: q.shipping.service,
        weight_grams: q.shipping.weightGrams,
        quoted_at: q.shipping.quotedAt,
        expires_at: q.shipping.expiresAt,
      },
    }),
  };
}
