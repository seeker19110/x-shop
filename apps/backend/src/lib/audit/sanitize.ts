import { maskEmail, maskPhone } from "@x-shop/domain";

/**
 * Che PII/bí mật trong `changes` của audit log trước khi ghi (ADM04 "tránh chép nguyên dữ liệu nhạy cảm", SEC05).
 * Hai lớp: theo TÊN khóa (bí mật → bỏ hẳn; email/điện thoại → che bằng maskEmail/maskPhone của domain; địa chỉ/họ
 * tên → thay hẳn) và theo GIÁ TRỊ (chuỗi trông như email/số điện thoại VN ở khóa bất kỳ cũng bị che).
 */
export const REDACTED = "[REDACTED]";
export const PII = "[PII]";

const SECRET_KEY = /(password|passwd|secret|token|otp|recovery|authorization|cookie|api_?key|hash|session)/i;
const EMAIL_KEY = /e-?mail/i;
const PHONE_KEY = /(phone|mobile|^tel$|sdt)/i;
const PII_KEY =
  /(address|street|first_name|last_name|full_name|recipient|^ip$|ip_address|birth|national_id|cccd)/i;

const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Số điện thoại VN: 0xxxxxxxxx / +84xxxxxxxxx (9–11 chữ số sau đầu số), cho phép khoảng trắng/chấm/gạch.
const PHONE_VALUE = /^(\+?84|0)[\d .-]{8,13}$/;

// Email/số điện thoại lẫn trong văn bản tự do (ghi chú, lý do) cũng bị che.
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Cho phép khoảng trắng/chấm/gạch giữa các chữ số ("+84 912 345 678", "0912.345.678").
const PHONE_IN_TEXT = /(?<!\d)(?:\+?84|0)(?:[ .-]?\d){8,10}(?!\d)/gu;
// Địa chỉ trong văn bản: cụm báo hiệu ("địa chỉ", "đ/c", "số nhà", "sn") che tới hết mệnh đề (`;`/xuống dòng/chấm cách);
// hoặc "số|ngõ|ngách|hẻm|kiệt <số>" kèm các cấp hành chính liền sau (đường/phố/phường/xã/quận/huyện/tp/tỉnh).
const ADDRESS_CUE_IN_TEXT =
  /(?<![\p{L}\d_])(?:địa chỉ|đ[/]c|số nhà|nhà số|sn)(?![\p{L}\d_])[^;\n]*?(?=;|\n|\.\s|\.$|$)/giu;
const STREET_IN_TEXT =
  /(?<![\p{L}\d_])(?:số|ngõ|ngách|hẻm|kiệt)\s*\d[\p{L}\d/-]*(?:\s*,?\s*(?:đường|phố|phường|xã|quận|huyện|thôn|tổ|tp\.?|thành phố|tỉnh)\s+[\p{L}\d][\p{L}\d ]*?(?=,|;|\n|\.\s|\.$|$))*/giu;

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_STRING = 1000;

function maskString(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (PII_KEY.test(key)) return PII;
  if (EMAIL_KEY.test(key) || EMAIL_VALUE.test(value)) return maskEmail(value);
  if (PHONE_KEY.test(key) || PHONE_VALUE.test(value)) return maskPhone(value.replace(/[ .-]/g, ""));
  const masked = maskFreeText(value);
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
}

/**
 * Che PII lẫn trong văn bản tự do (ghi chú/lý do do khách hoặc nhân viên nhập): email → maskEmail, số điện thoại VN →
 * maskPhone (bỏ khoảng trắng/chấm/gạch), địa chỉ → "[PII]" (nhận diện theo cụm báo hiệu — heuristic, không hứa bắt hết).
 * Văn bản không có PII giữ nguyên từng ký tự (Unicode tiếng Việt không bị đổi). Dùng chung cho audit và các route trả ra.
 */
export function maskFreeText(value: string): string;
export function maskFreeText(value: string | null | undefined): string | null;
export function maskFreeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value
    .replace(EMAIL_IN_TEXT, (m) => maskEmail(m))
    .replace(PHONE_IN_TEXT, (m) => maskPhone(m.replace(/[ .-]/g, "")))
    .replace(ADDRESS_CUE_IN_TEXT, PII)
    .replace(STREET_IN_TEXT, PII);
}

function walk(key: string, value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return maskString(key, value);
  if (typeof value === "number" || typeof value === "boolean") {
    return PHONE_KEY.test(key) || PII_KEY.test(key) ? PII : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => walk(key, v, depth + 1));
  if (typeof value === "object") {
    if (PII_KEY.test(key)) return PII;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (v !== undefined) out[k] = walk(k, v, depth + 1);
    }
    return out;
  }
  return null;
}

export function sanitizeChanges(changes: Record<string, unknown>): Record<string, unknown> {
  return walk("", changes, 0) as Record<string, unknown>;
}

/** Độ dài tối đa của `user_agent` trong audit (CHECK ở DB, Migration20261026210000). */
export const USER_AGENT_MAX = 256;
// Ký tự điều khiển C0/C1, DEL, ký tự định hướng chữ (bidi), U+2028/2029 — không thuộc User-Agent hợp lệ.
// eslint-disable-next-line no-control-regex -- lọc chính ký tự điều khiển khỏi header do client gửi
const UA_STRIP = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * User-Agent cho audit (SEC-LOG-002 `user_agent`): header do client gửi = dữ liệu không tin cậy → bỏ ký tự điều khiển,
 * gộp khoảng trắng, che email/SĐT lẫn trong chuỗi (maskFreeText — vài ứng dụng nhúng tài khoản vào UA), cắt ≤ 256 ký tự
 * (theo code point, không cắt đôi cặp surrogate). Rỗng/không phải chuỗi → null; mảng (header lặp) → phần tử đầu.
 */
export function sanitizeUserAgent(value: unknown): string | null {
  const raw: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const cleaned = maskFreeText(
    raw
      .slice(0, USER_AGENT_MAX * 4)
      .replace(UA_STRIP, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (cleaned.length === 0) return null;
  return [...cleaned].slice(0, USER_AGENT_MAX).join("");
}
