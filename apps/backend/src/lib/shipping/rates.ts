import type { AddressSnapshot } from "@x-shop/domain";
import { CheckoutError } from "../checkout/errors";
import { SHIPPING_CONFIG } from "./config";
import { getGhnClient, GhnError } from "./ghn-client";

/**
 * Báo phí vận chuyển cho quote checkout (thay bảng phí tạm của T-010): hỏi GHN theo địa chỉ 2 cấp + khối lượng.
 * Báo phí có thời điểm và hết hạn (đặc tả §6.4): giữ trong bộ nhớ đệm của tiến trình tới `expiresAt` để quote và
 * submit trong cùng hạn thấy cùng một phí; hết hạn → hỏi lại hãng (phí đổi thì submit trả SHIPPING_CHANGED như cũ).
 * Địa chỉ hãng không phục vụ → 422 ADDRESS_NOT_SERVED trước khi khách xác nhận.
 */
export interface ShippingFeeQuote {
  fee: number;
  service: string;
  weightGrams: number;
  provider: "ghn";
  quotedAt: string;
  expiresAt: string;
}

const cache = new Map<string, ShippingFeeQuote>();

export function clearShippingFeeCache(): void {
  cache.clear();
}

export async function quoteShippingFee(
  address: AddressSnapshot,
  weightGrams: number,
  insuranceValue: number,
  now: Date = new Date(),
): Promise<ShippingFeeQuote> {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) {
    throw new RangeError(`khối lượng phải là số nguyên gram không âm, nhận ${String(weightGrams)}`);
  }
  const weight = Math.max(SHIPPING_CONFIG.minWeightGrams, weightGrams);
  const key = `${address.provinceCode}|${address.wardCode}|${weight}|${insuranceValue}`;
  const hit = cache.get(key);
  if (hit && now.getTime() < Date.parse(hit.expiresAt)) return hit;
  let fee: { fee: number; service: string };
  try {
    fee = await getGhnClient().quoteFee({ to: address, weightGrams: weight, insuranceValue });
  } catch (e) {
    if (e instanceof GhnError && (e.kind === "not_served" || e.kind === "rejected")) {
      throw new CheckoutError("ADDRESS_NOT_SERVED", undefined, { field: "address" });
    }
    throw new CheckoutError("SHIPPING_UNAVAILABLE");
  }
  const quote: ShippingFeeQuote = {
    fee: fee.fee,
    service: fee.service,
    weightGrams: weight,
    provider: "ghn",
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHIPPING_CONFIG.feeQuoteTtlMs).toISOString(),
  };
  if (cache.size >= SHIPPING_CONFIG.feeCacheMaxEntries) {
    for (const [k, v] of cache) if (now.getTime() >= Date.parse(v.expiresAt)) cache.delete(k);
    if (cache.size >= SHIPPING_CONFIG.feeCacheMaxEntries) cache.clear();
  }
  cache.set(key, quote);
  return quote;
}
