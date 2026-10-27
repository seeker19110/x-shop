/**
 * Phí ship đã báo trong quote còn hiệu lực tới submit (đặc tả §6.4; T-153). Quote lưu kèm ảnh chụp báo phí của hãng
 * (`ShippingFeeSnapshot`); submit dùng lại đúng phí đó — không hỏi lại hãng, không phụ thuộc bộ nhớ của tiến trình nào —
 * khi và chỉ khi: quote và báo phí còn hạn, phí trong ảnh chụp đúng phí đã tính vào quote, và MỌI đầu vào định phí
 * (tỉnh, phường, khối lượng đã chuẩn hoá, giá trị khai bảo hiểm, dịch vụ, phương thức thanh toán) không đổi. Lệch bất kỳ
 * điều kiện nào → `null`: backend hỏi lại hãng, phí khác thì submit trả `SHIPPING_CHANGED` như cũ. Hàm thuần.
 */

/** Đầu vào định phí đã chuẩn hoá (khối lượng sau mức tối thiểu, giá trị khai số nguyên VND). */
export interface ShippingFeeBasis {
  provinceCode: string;
  wardCode: string;
  weightGrams: number;
  insuranceValue: number;
  service: string;
}

/** Báo phí của hãng tại thời điểm quote — lưu nguyên vào `checkout_quote.shipping`. */
export interface ShippingFeeSnapshot extends ShippingFeeBasis {
  fee: number;
  provider: string;
  /** ISO 8601 UTC. */
  quotedAt: string;
  /** ISO 8601 UTC — sau mốc này báo phí hết hiệu lực. */
  expiresAt: string;
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isInstant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Đọc ảnh chụp đã lưu (JSON từ DB); thiếu/sai bất kỳ trường nào → `null` (quote cũ chưa có ảnh chụp cũng vậy). */
export function parseShippingFeeSnapshot(raw: unknown): ShippingFeeSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isNonNegativeInt(r.fee) ||
    !isText(r.provider) ||
    !isText(r.service) ||
    !isText(r.provinceCode) ||
    !isText(r.wardCode) ||
    !isNonNegativeInt(r.weightGrams) ||
    !isNonNegativeInt(r.insuranceValue) ||
    !isInstant(r.quotedAt) ||
    !isInstant(r.expiresAt)
  ) {
    return null;
  }
  return {
    fee: r.fee,
    provider: r.provider,
    service: r.service,
    provinceCode: r.provinceCode,
    wardCode: r.wardCode,
    weightGrams: r.weightGrams,
    insuranceValue: r.insuranceValue,
    quotedAt: r.quotedAt,
    expiresAt: r.expiresAt,
  };
}

export interface QuotedShipping {
  /** Ảnh chụp báo phí lưu cùng quote (JSON thô từ DB, có thể null). */
  snapshot: unknown;
  /** `breakdown.shippingFee` của quote khách đã xác nhận. */
  shippingFee: unknown;
  paymentMethod: string;
  /** Hạn của quote. */
  expiresAt: Date | string;
}

/**
 * Phí đã báo còn dùng được cho submit? Trả ảnh chụp để dùng lại, hoặc `null` = phải hỏi lại hãng.
 * Biên thời gian: `now >= hạn` là hết hạn (hạn = sớm hơn giữa hạn quote và hạn báo phí).
 */
export function reusableShippingFee(
  quoted: QuotedShipping,
  current: ShippingFeeBasis & { paymentMethod: string },
  now: Date,
): ShippingFeeSnapshot | null {
  const snap = parseShippingFeeSnapshot(quoted.snapshot);
  if (snap === null) return null;
  if (quoted.shippingFee !== snap.fee) return null;
  const quoteExpiry = new Date(quoted.expiresAt).getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(quoteExpiry) || !Number.isFinite(nowMs)) return null;
  if (nowMs >= Math.min(quoteExpiry, Date.parse(snap.expiresAt))) return null;
  const same =
    quoted.paymentMethod === current.paymentMethod &&
    snap.provinceCode === current.provinceCode &&
    snap.wardCode === current.wardCode &&
    snap.weightGrams === current.weightGrams &&
    snap.insuranceValue === current.insuranceValue &&
    snap.service === current.service;
  return same ? snap : null;
}
