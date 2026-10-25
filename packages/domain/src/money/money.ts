/**
 * Tiền VND là số nguyên đồng (ISO 4217 VND, exponent 0) — không float (BASE-DATA-005, PRICE01).
 * `number` an toàn tới 2^53 − 1 ≈ 9 triệu tỷ đồng, đủ cho mọi đơn; mọi phép tính kiểm `Number.isSafeInteger`.
 */
export const CURRENCY = "VND" as const;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

export function assertVnd(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} phải là số nguyên VND an toàn, nhận ${String(value)}`);
  }
  return value;
}

export function assertNonNegativeVnd(value: number, label = "amount"): number {
  assertVnd(value, label);
  if (value < 0) throw new MoneyError(`${label} không được âm, nhận ${value}`);
  return value;
}

export function sumVnd(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total = assertVnd(total + assertVnd(v), "tổng");
  }
  return total;
}

export function multiplyVnd(amount: number, quantity: number): number {
  assertVnd(amount);
  if (!Number.isSafeInteger(quantity)) throw new MoneyError(`số lượng phải là số nguyên, nhận ${quantity}`);
  return assertVnd(amount * quantity, "thành tiền");
}

/**
 * Phần trăm theo basis point (1% = 100 bp), làm tròn XUỐNG tới đồng: một mức giảm "10%" không bao giờ vượt 10%
 * (D-002). Dùng phép nguyên để tránh sai số nhị phân.
 */
export function percentOfVnd(amount: number, basisPoints: number): number {
  assertNonNegativeVnd(amount);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new MoneyError(`basisPoints phải trong [0, 10000], nhận ${basisPoints}`);
  }
  // amount * bp có thể vượt 2^53 với amount rất lớn → dùng BigInt cho phép nhân/chia.
  return Number((BigInt(amount) * BigInt(basisPoints)) / 10_000n);
}

/**
 * Phân bổ `total` theo trọng số bằng phương pháp phần dư lớn nhất (Hamilton/largest remainder).
 * Bảo đảm: tổng kết quả = total đúng tuyệt đối; mỗi phần ≤ ⌈total·w/W⌉; hòa phần dư → chỉ số nhỏ hơn trước (D-002).
 * total và trọng số là số nguyên không âm; W = 0 chỉ hợp lệ khi total = 0.
 */
export function allocateVnd(total: number, weights: readonly number[]): number[] {
  assertNonNegativeVnd(total, "total");
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new MoneyError("không có dòng nào để phân bổ");
  }
  weights.forEach((w, i) => assertNonNegativeVnd(w, `weights[${i}]`));
  const weightSum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (weightSum === 0n) {
    if (total === 0) return weights.map(() => 0);
    throw new MoneyError("tổng trọng số bằng 0 nhưng total > 0");
  }
  const t = BigInt(total);
  const base = weights.map((w) => (t * BigInt(w)) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (t * BigInt(w)) % weightSum }));
  let left = t - base.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    base[i] = (base[i] as bigint) + 1n;
    left -= 1n;
  }
  return base.map((b) => Number(b));
}

/** Chia đều số tiền thực trả của một dòng cho từng đơn vị (để trả/hoàn từng phần — PRICE03, AT15). */
export function unitShares(lineTotal: number, quantity: number): number[] {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new MoneyError(`số lượng phải là số nguyên dương, nhận ${quantity}`);
  }
  return allocateVnd(
    lineTotal,
    Array.from({ length: quantity }, () => 1),
  );
}

/**
 * Số tiền hoàn cho `count` đơn vị kế tiếp của một dòng, khi đã trả trước đó `alreadyReturned` đơn vị.
 * Lấy theo thứ tự cố định để nhiều lần trả một phần cộng lại đúng bằng tổng dòng.
 */
export function refundForUnits(
  lineTotal: number,
  quantity: number,
  alreadyReturned: number,
  count: number,
): number {
  if (!Number.isSafeInteger(alreadyReturned) || alreadyReturned < 0) {
    throw new MoneyError("alreadyReturned không hợp lệ");
  }
  if (!Number.isSafeInteger(count) || count <= 0) throw new MoneyError("count phải là số nguyên dương");
  if (alreadyReturned + count > quantity) {
    throw new MoneyError(`trả ${alreadyReturned + count} vượt số lượng ${quantity}`);
  }
  return sumVnd(unitShares(lineTotal, quantity).slice(alreadyReturned, alreadyReturned + count));
}

const vndFormatter = new Intl.NumberFormat("vi-VN");

/** Hiển thị: "1.300.000 ₫". */
export function formatVnd(amount: number): string {
  return `${vndFormatter.format(assertVnd(amount))} ₫`;
}
