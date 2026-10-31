import { vnpay } from "@x-shop/domain";

/**
 * Xoay khoá ký VNPAY không gián đoạn (BE-INT-002, T-099).
 *
 *  - KÝ (URL thanh toán, querydr, refund): luôn `hashSecret` (khoá hiện tại) — các hàm build* của `@x-shop/domain` chỉ
 *    nhận một khoá nên không thể ký nhầm bằng khoá trước.
 *  - XÁC MINH (IPN/return, phản hồi querydr): thử khoá hiện tại, chữ ký sai mới thử `hashSecretPrevious` (nếu đặt).
 *    Chỉ lỗi CHỮ KÝ mới thử lại — `MALFORMED`/`MERCHANT_MISMATCH`/sai số tiền… trả ngay kết quả của khoá hiện tại.
 *  - Mỗi khoá so sánh hằng thời gian (`safeEqualHex` trong domain).
 */
export interface VnpayVerifyKeys {
  tmnCode: string;
  hashSecret: string;
  hashSecretPrevious?: string | null;
}

export type SecretUsed = "current" | "previous";

/** Khoá dùng để xác minh, theo thứ tự thử (hiện tại trước; khoá trước bỏ qua nếu rỗng/trùng). */
export function verificationSecrets(cfg: VnpayVerifyKeys): Array<{ used: SecretUsed; secret: string }> {
  const out: Array<{ used: SecretUsed; secret: string }> = [{ used: "current", secret: cfg.hashSecret }];
  const prev = cfg.hashSecretPrevious;
  if (typeof prev === "string" && prev !== "" && prev !== cfg.hashSecret)
    out.push({ used: "previous", secret: prev });
  return out;
}

/** `vnpay.verifyNotification` nhận khoá hiện tại hoặc khoá trước; `secretUsed` có khi hợp lệ (để biết lúc bỏ khoá cũ). */
export function verifyNotificationWithRotation(
  cfg: VnpayVerifyKeys,
  query: URLSearchParams | Record<string, string>,
): vnpay.VerifyResult & { secretUsed?: SecretUsed } {
  let first: vnpay.VerifyResult | null = null;
  for (const { used, secret } of verificationSecrets(cfg)) {
    const r = vnpay.verifyNotification({ tmnCode: cfg.tmnCode, hashSecret: secret }, query);
    if (r.ok) return { ...r, secretUsed: used };
    first ??= r;
    if (r.code !== "INVALID_SIGNATURE") return r;
  }
  return first!;
}

/** `vnpay.interpretQueryResponse` với khoá hiện tại hoặc khoá trước (chỉ thử lại khi `reason = invalid_signature`). */
export function interpretQueryResponseWithRotation(
  cfg: VnpayVerifyKeys,
  res: Record<string, unknown>,
  expected: { txnRef: string; amount: number },
): ReturnType<typeof vnpay.interpretQueryResponse> {
  let first: ReturnType<typeof vnpay.interpretQueryResponse> | null = null;
  for (const { secret } of verificationSecrets(cfg)) {
    const r = vnpay.interpretQueryResponse({ tmnCode: cfg.tmnCode, hashSecret: secret }, res, expected);
    if (r.reason !== "invalid_signature") return r;
    first ??= r;
  }
  return first!;
}
