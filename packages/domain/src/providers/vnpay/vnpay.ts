/**
 * Protocol VNPAY PAY v2.1.0 (thanh toán qua cổng, IPN GET, querydr/refund JSON).
 * NGUỒN: tài liệu chính thức https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html KHÔNG truy cập được ngày
 * 2026-10-24 (docs/research/2026-10-24-stack.md mục 6) — cài theo nguồn thứ cấp (chưa xác minh). Bắt buộc đối chiếu lại
 * với tài liệu merchant được cấp trước sandbox thật (RK-006). Mọi chuỗi ký tập trung ở file này để sửa một chỗ.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { assertNonNegativeVnd } from "../../money/money.js";

export const VNPAY_VERSION = "2.1.0";

export interface VnpayConfig {
  tmnCode: string;
  hashSecret: string;
  /** vd https://sandbox.vnpayment.vn/paymentv2/vpcpay.html */
  paymentUrl: string;
  /** vd https://sandbox.vnpayment.vn/merchant_webapi/api/transaction */
  apiUrl: string;
  returnUrl: string;
}

/** Mã RspCode phản hồi IPN (theo nguồn thứ cấp — chưa xác minh). */
export const IPN_RESPONSES = {
  success: { RspCode: "00", Message: "Confirm Success" },
  orderNotFound: { RspCode: "01", Message: "Order not found" },
  alreadyConfirmed: { RspCode: "02", Message: "Order already confirmed" },
  invalidAmount: { RspCode: "04", Message: "invalid amount" },
  invalidSignature: { RspCode: "97", Message: "Invalid signature" },
  unknownError: { RspCode: "99", Message: "Unknow error" },
} as const;
export type IpnResponse = (typeof IPN_RESPONSES)[keyof typeof IPN_RESPONSES];

/** Mã hóa kiểu PHP urlencode (khoảng trắng → "+") — chuỗi ký phải giống hệt phía VNPAY. */
export function vnpEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function hmacSha512(secret: string, data: string): string {
  return createHmac("sha512", secret).update(data, "utf8").digest("hex");
}

/** Chuỗi ký: các tham số vnp_* (trừ SecureHash/SecureHashType), sắp tăng theo key, `k=v` đã encode nối bằng `&`. */
export function signData(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k.startsWith("vnp_") && k !== "vnp_SecureHash" && k !== "vnp_SecureHashType")
    .sort()
    .map((k) => `${vnpEncode(k)}=${vnpEncode(params[k] as string)}`)
    .join("&");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), "utf8");
  const y = Buffer.from(b.toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Thời gian VNPAY: yyyyMMddHHmmss theo giờ Việt Nam (GMT+7, không DST). Lưu trữ vẫn là UTC. */
export function toVnpDate(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(
    t.getUTCMinutes(),
  )}${p(t.getUTCSeconds())}`;
}

export function fromVnpDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  const ms = Date.UTC(y!, mo! - 1, d!, h! - 7, mi!, se!);
  const out = new Date(ms);
  return toVnpDate(out) === s ? out : null;
}

export interface CreatePaymentInput {
  /** Reference ổn định của payment attempt (vnp_TxnRef) — không dùng lại cho attempt khác. */
  txnRef: string;
  amount: number;
  orderInfo: string;
  ipAddr: string;
  createdAt: Date;
  expiresAt: Date;
  locale?: "vn" | "en";
  bankCode?: string;
}

/** Tạo URL chuyển khách sang VNPAY. Số tiền ×100 theo protocol; orderInfo không dấu, không ký tự đặc biệt. */
export function buildPaymentUrl(cfg: VnpayConfig, input: CreatePaymentInput): string {
  assertNonNegativeVnd(input.amount, "amount");
  if (input.amount === 0) throw new Error("Không tạo phiên VNPAY cho số tiền 0");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.txnRef)) throw new Error("txnRef không hợp lệ");
  if (input.expiresAt.getTime() <= input.createdAt.getTime()) throw new Error("expiresAt phải sau createdAt");
  const params: Record<string, string> = {
    vnp_Version: VNPAY_VERSION,
    vnp_Command: "pay",
    vnp_TmnCode: cfg.tmnCode,
    vnp_Amount: String(input.amount * 100),
    vnp_CurrCode: "VND",
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: sanitizeOrderInfo(input.orderInfo),
    vnp_OrderType: "other",
    vnp_Locale: input.locale ?? "vn",
    vnp_ReturnUrl: cfg.returnUrl,
    vnp_IpAddr: input.ipAddr,
    vnp_CreateDate: toVnpDate(input.createdAt),
    vnp_ExpireDate: toVnpDate(input.expiresAt),
  };
  if (input.bankCode) params.vnp_BankCode = input.bankCode;
  const data = signData(params);
  return `${cfg.paymentUrl}?${data}&vnp_SecureHash=${hmacSha512(cfg.hashSecret, data)}`;
}

export function sanitizeOrderInfo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"))
    .replace(/[^A-Za-z0-9 .:,_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

export type VerifiedNotification = {
  txnRef: string;
  /** VND (đã chia 100). */
  amount: number;
  responseCode: string;
  transactionStatus: string;
  /** Mã giao dịch phía VNPAY — khóa chống ghi trùng khoản thu. */
  transactionNo: string;
  bankCode: string | null;
  payDate: Date | null;
  /** Thành công thật sự: cả ResponseCode và TransactionStatus là "00". */
  success: boolean;
  tmnCode: string;
};

export type VerifyResult =
  | { ok: true; value: VerifiedNotification }
  | { ok: false; code: "INVALID_SIGNATURE" | "MALFORMED" | "MERCHANT_MISMATCH" };

/**
 * Xác minh IPN/return (cùng định dạng query). Chữ ký sai → INVALID_SIGNATURE (RspCode 97). Chỉ tham số `vnp_*`
 * được ký; tham số lạ bị bỏ qua khi ký nhưng không làm hỏng xác minh.
 */
export function verifyNotification(
  cfg: Pick<VnpayConfig, "hashSecret" | "tmnCode">,
  query: URLSearchParams | Record<string, string>,
): VerifyResult {
  const params: Record<string, string> = {};
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query);
  if (entries.length > 64) return { ok: false, code: "MALFORMED" };
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.length > 1024) return { ok: false, code: "MALFORMED" };
    if (k.startsWith("vnp_")) params[k] = v;
  }
  const given = params.vnp_SecureHash;
  if (!given || !/^[0-9a-fA-F]{128}$/.test(given)) return { ok: false, code: "INVALID_SIGNATURE" };
  if (!safeEqualHex(hmacSha512(cfg.hashSecret, signData(params)), given)) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
  const amountRaw = params.vnp_Amount ?? "";
  if (!/^\d{1,17}$/.test(amountRaw) || Number(amountRaw) % 100 !== 0) return { ok: false, code: "MALFORMED" };
  const txnRef = params.vnp_TxnRef;
  if (!txnRef) return { ok: false, code: "MALFORMED" };
  if (params.vnp_TmnCode !== cfg.tmnCode) return { ok: false, code: "MERCHANT_MISMATCH" };
  const responseCode = params.vnp_ResponseCode ?? "";
  const transactionStatus = params.vnp_TransactionStatus ?? "";
  return {
    ok: true,
    value: {
      txnRef,
      amount: Number(amountRaw) / 100,
      responseCode,
      transactionStatus,
      transactionNo: params.vnp_TransactionNo ?? "",
      bankCode: params.vnp_BankCode ?? null,
      payDate: params.vnp_PayDate ? fromVnpDate(params.vnp_PayDate) : null,
      success: responseCode === "00" && transactionStatus === "00",
      tmnCode: params.vnp_TmnCode,
    },
  };
}

export interface ApiCommon {
  requestId: string;
  ipAddr: string;
  createdAt: Date;
}

/** Body querydr (JSON POST). Chuỗi ký nối `|` theo thứ tự cố định (theo nguồn thứ cấp — chưa xác minh). */
export function buildQueryDr(
  cfg: Pick<VnpayConfig, "tmnCode" | "hashSecret">,
  input: ApiCommon & { txnRef: string; transactionDate: Date; orderInfo: string },
): Record<string, string> {
  const body = {
    vnp_RequestId: input.requestId,
    vnp_Version: VNPAY_VERSION,
    vnp_Command: "querydr",
    vnp_TmnCode: cfg.tmnCode,
    vnp_TxnRef: input.txnRef,
    vnp_OrderInfo: sanitizeOrderInfo(input.orderInfo),
    vnp_TransactionDate: toVnpDate(input.transactionDate),
    vnp_CreateDate: toVnpDate(input.createdAt),
    vnp_IpAddr: input.ipAddr,
  };
  const data = [
    body.vnp_RequestId,
    body.vnp_Version,
    body.vnp_Command,
    body.vnp_TmnCode,
    body.vnp_TxnRef,
    body.vnp_TransactionDate,
    body.vnp_CreateDate,
    body.vnp_IpAddr,
    body.vnp_OrderInfo,
  ].join("|");
  return { ...body, vnp_SecureHash: hmacSha512(cfg.hashSecret, data) };
}

/** Body refund: `02` hoàn toàn phần, `03` một phần. Retry dùng cùng requestId của refund (không tạo refund mới). */
export function buildRefund(
  cfg: Pick<VnpayConfig, "tmnCode" | "hashSecret">,
  input: ApiCommon & {
    txnRef: string;
    amount: number;
    full: boolean;
    transactionNo: string;
    transactionDate: Date;
    createdBy: string;
    orderInfo: string;
  },
): Record<string, string> {
  assertNonNegativeVnd(input.amount, "amount");
  const body = {
    vnp_RequestId: input.requestId,
    vnp_Version: VNPAY_VERSION,
    vnp_Command: "refund",
    vnp_TmnCode: cfg.tmnCode,
    vnp_TransactionType: input.full ? "02" : "03",
    vnp_TxnRef: input.txnRef,
    vnp_Amount: String(input.amount * 100),
    vnp_TransactionNo: input.transactionNo,
    vnp_TransactionDate: toVnpDate(input.transactionDate),
    vnp_CreateBy: input.createdBy,
    vnp_CreateDate: toVnpDate(input.createdAt),
    vnp_IpAddr: input.ipAddr,
    vnp_OrderInfo: sanitizeOrderInfo(input.orderInfo),
  };
  const data = [
    body.vnp_RequestId,
    body.vnp_Version,
    body.vnp_Command,
    body.vnp_TmnCode,
    body.vnp_TransactionType,
    body.vnp_TxnRef,
    body.vnp_Amount,
    body.vnp_TransactionNo,
    body.vnp_TransactionDate,
    body.vnp_CreateBy,
    body.vnp_CreateDate,
    body.vnp_IpAddr,
    body.vnp_OrderInfo,
  ].join("|");
  return { ...body, vnp_SecureHash: hmacSha512(cfg.hashSecret, data) };
}

export const QUERY_RESPONSE_FIELDS = [
  "vnp_ResponseId",
  "vnp_Command",
  "vnp_ResponseCode",
  "vnp_Message",
  "vnp_TmnCode",
  "vnp_TxnRef",
  "vnp_Amount",
  "vnp_BankCode",
  "vnp_PayDate",
  "vnp_TransactionNo",
  "vnp_TransactionType",
  "vnp_TransactionStatus",
  "vnp_OrderInfo",
  "vnp_PromotionCode",
  "vnp_PromotionAmount",
] as const;

export type QueryOutcome = "paid" | "not_paid" | "failed" | "unknown";

/**
 * Xác minh và diễn giải phản hồi querydr. Chữ ký sai hoặc mã lạ → "unknown" (không suy diễn là chưa trả:
 * timeout/không rõ được xử lý như chưa xác định cho tới khi đối chiếu — §7.3).
 */
export function interpretQueryResponse(
  cfg: Pick<VnpayConfig, "hashSecret" | "tmnCode">,
  res: Record<string, unknown>,
  expected: { txnRef: string; amount: number },
): { outcome: QueryOutcome; transactionNo: string | null; reason: string } {
  const get = (k: string) => (typeof res[k] === "string" ? (res[k] as string) : "");
  const data = QUERY_RESPONSE_FIELDS.map(get).join("|");
  const sig = get("vnp_SecureHash");
  if (!/^[0-9a-fA-F]{128}$/.test(sig) || !safeEqualHex(hmacSha512(cfg.hashSecret, data), sig)) {
    return { outcome: "unknown", transactionNo: null, reason: "invalid_signature" };
  }
  if (get("vnp_ResponseCode") !== "00") {
    return { outcome: "unknown", transactionNo: null, reason: `response_${get("vnp_ResponseCode")}` };
  }
  if (get("vnp_TmnCode") !== cfg.tmnCode || get("vnp_TxnRef") !== expected.txnRef) {
    return { outcome: "unknown", transactionNo: null, reason: "mismatch" };
  }
  const status = get("vnp_TransactionStatus");
  const txNo = get("vnp_TransactionNo") || null;
  if (status === "00") {
    if (get("vnp_Amount") !== String(expected.amount * 100)) {
      return { outcome: "unknown", transactionNo: txNo, reason: "amount_mismatch" };
    }
    return { outcome: "paid", transactionNo: txNo, reason: "status_00" };
  }
  // 01 = chưa hoàn tất tại thời điểm hỏi; caller chỉ coi là "không trả" SAU hạn phiên (vnp_ExpireDate).
  if (status === "01") return { outcome: "not_paid", transactionNo: txNo, reason: "status_01" };
  if (status === "02") return { outcome: "failed", transactionNo: txNo, reason: "status_02" };
  return { outcome: "unknown", transactionNo: txNo, reason: `status_${status}` };
}
