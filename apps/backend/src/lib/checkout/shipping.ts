import type { AddressSnapshot } from "@x-shop/domain";

/**
 * Bảng phí cố định theo khối lượng — từ T-026 chỉ còn là biểu phí của GHN giả lập (`MockModeGhnClient`, GHN_MODE=mock)
 * để tổng đơn dev/test ổn định; quote thật hỏi GHN qua `lib/shipping/rates.ts`. Hàm thuần, số nguyên VND.
 */
export interface ShippingFeeTable {
  /** Phí cho khối lượng tới `baseWeightGrams`. */
  baseFee: number;
  baseWeightGrams: number;
  /** Mỗi `stepWeightGrams` (làm tròn lên) vượt mức cơ sở cộng `stepFee`. */
  stepWeightGrams: number;
  stepFee: number;
  /** Khối lượng mặc định mỗi sản phẩm khi biến thể chưa khai `weight` (gram). */
  defaultItemWeightGrams: number;
  /** Mã dịch vụ ghi vào snapshot đơn. */
  service: string;
}

export const SHIPPING_FEE_TABLE: ShippingFeeTable = {
  baseFee: 30_000,
  baseWeightGrams: 1_000,
  stepWeightGrams: 500,
  stepFee: 5_000,
  defaultItemWeightGrams: 300,
  service: "flat-table-p0",
};

export interface ShippingQuote {
  fee: number;
  service: string;
  weightGrams: number;
}

export function quoteShipping(
  address: Pick<AddressSnapshot, "provinceCode" | "wardCode">,
  weightGrams: number,
  table: ShippingFeeTable = SHIPPING_FEE_TABLE,
): ShippingQuote {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) {
    throw new RangeError(`khối lượng phải là số nguyên gram không âm, nhận ${String(weightGrams)}`);
  }
  // P0: bảng phí không phụ thuộc địa chỉ (đã validate ở domain); GHN thật dùng province/ward.
  void address;
  const extra = Math.max(0, weightGrams - table.baseWeightGrams);
  const steps = Math.ceil(extra / table.stepWeightGrams);
  return { fee: table.baseFee + steps * table.stepFee, service: table.service, weightGrams };
}

/** Tổng khối lượng giỏ: Σ (weight biến thể hoặc mặc định) × số lượng. */
export function cartWeightGrams(
  lines: ReadonlyArray<{ weightGrams: number | null | undefined; quantity: number }>,
  table: ShippingFeeTable = SHIPPING_FEE_TABLE,
): number {
  let total = 0;
  for (const l of lines) {
    const w = l.weightGrams;
    const unit =
      typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.ceil(w) : table.defaultItemWeightGrams;
    total += unit * l.quantity;
  }
  return total;
}
