import type { AddressSnapshot, ShippingFeeBasis, ShippingFeeSnapshot } from "@x-shop/domain";
import { CheckoutError } from "../checkout/errors";
import { SHIPPING_CONFIG } from "./config";
import { getGhnClient, GhnError } from "./ghn-client";

/**
 * Báo phí vận chuyển cho quote checkout (thay bảng phí tạm của T-010): hỏi GHN theo địa chỉ 2 cấp + khối lượng.
 * Báo phí có thời điểm và hết hạn (đặc tả §6.4). Không giữ trạng thái trong tiến trình (T-153): mỗi lần gọi là hỏi hãng;
 * phí đã báo được lưu cùng quote (`checkout_quote.shipping`) và submit dùng lại khi quote còn hạn và đầu vào định phí
 * không đổi (`reusableShippingFee` của domain) — quote ở bản sao này, submit ở bản sao kia vẫn thấy cùng một phí.
 * Địa chỉ hãng không phục vụ → 422 ADDRESS_NOT_SERVED trước khi khách xác nhận.
 */
export type ShippingFeeQuote = ShippingFeeSnapshot & { provider: "ghn" };

/** Đầu vào định phí đã chuẩn hoá: khối lượng nâng lên mức tối thiểu gửi hãng, dịch vụ theo cấu hình. */
export function shippingFeeBasis(
  address: Pick<AddressSnapshot, "provinceCode" | "wardCode">,
  weightGrams: number,
  insuranceValue: number,
): ShippingFeeBasis {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) {
    throw new RangeError(`khối lượng phải là số nguyên gram không âm, nhận ${String(weightGrams)}`);
  }
  if (!Number.isSafeInteger(insuranceValue) || insuranceValue < 0) {
    throw new RangeError(`giá trị khai phải là số nguyên VND không âm, nhận ${String(insuranceValue)}`);
  }
  return {
    provinceCode: address.provinceCode,
    wardCode: address.wardCode,
    weightGrams: Math.max(SHIPPING_CONFIG.minWeightGrams, weightGrams),
    insuranceValue,
    service: SHIPPING_CONFIG.service,
  };
}

/** Hỏi hãng một báo phí mới (luôn gọi hãng — không cache). */
export async function quoteShippingFee(
  address: AddressSnapshot,
  weightGrams: number,
  insuranceValue: number,
  now: Date = new Date(),
): Promise<ShippingFeeQuote> {
  const basis = shippingFeeBasis(address, weightGrams, insuranceValue);
  let fee: { fee: number; service: string };
  try {
    fee = await getGhnClient().quoteFee({
      to: address,
      weightGrams: basis.weightGrams,
      insuranceValue: basis.insuranceValue,
    });
  } catch (e) {
    if (e instanceof GhnError && (e.kind === "not_served" || e.kind === "rejected")) {
      throw new CheckoutError("ADDRESS_NOT_SERVED", undefined, { field: "address" });
    }
    throw new CheckoutError("SHIPPING_UNAVAILABLE");
  }
  return {
    // `service` giữ dịch vụ cấu hình (đầu vào định phí, so khớp lúc submit); mã hãng trả về để riêng ở `providerService`.
    ...basis,
    fee: fee.fee,
    providerService: fee.service,
    provider: "ghn",
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHIPPING_CONFIG.feeQuoteTtlMs).toISOString(),
  };
}
