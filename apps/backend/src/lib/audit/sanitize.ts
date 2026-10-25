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
const PHONE_IN_TEXT = /(?<!\d)(?:\+?84|0)\d{8,10}(?!\d)/g;

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_STRING = 1000;

function maskString(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (PII_KEY.test(key)) return PII;
  if (EMAIL_KEY.test(key) || EMAIL_VALUE.test(value)) return maskEmail(value);
  if (PHONE_KEY.test(key) || PHONE_VALUE.test(value)) return maskPhone(value.replace(/[ .-]/g, ""));
  const masked = value
    .replace(EMAIL_IN_TEXT, (m) => maskEmail(m))
    .replace(PHONE_IN_TEXT, (m) => maskPhone(m));
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
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
