import { looksLikePii } from "../analytics/schema";

/**
 * Che bí mật + PII trước khi ghi log storefront (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008, T-190).
 *
 * Không import backend (hai app độc lập); dùng lại bộ nhận diện PII của `analytics/schema.ts` (thuần TS) — hai bản cùng bị
 * khoá bởi bộ mẫu chung `scripts/fixtures/pii-samples.json` (D-065; test `logger.test.ts`). Hai lớp:
 *  1. Theo TÊN trường: mật khẩu/token/cookie/khoá/chữ ký… và PII (email, SĐT, địa chỉ, CCCD, họ tên, ngày sinh, IP) → cả
 *     giá trị (kể cả object/mảng) thành `[REDACTED]`.
 *  2. Theo NỘI DUNG chuỗi: giống PII (`looksLikePii`) hoặc chứa bí mật (Bearer/Basic, JWT, `khoá=giá trị`) → CẢ chuỗi thành
 *     `[REDACTED]` (an toàn hơn che từng đoạn: storefront không cần giữ phần còn lại của thông điệp có PII).
 *     Dòng `at …` của stack chỉ kiểm bí mật + email (đường dẫn tệp `12/3`, tên hàm `so` làm bộ nhận địa chỉ nhận nhầm).
 * Không đổi đầu vào. Vòng tham chiếu → `[Circular]`; sâu quá `MAX_DEPTH` → `[Truncated]`; chuỗi dài quá `MAX_TEXT` bị cắt
 * TRƯỚC khi quét (chặn chi phí CPU). Mọi regex có biên lặp hoặc phân tách bởi ký tự khác lớp (không nhóm lặp mơ hồ, ReDoS).
 */

export const REDACTED = "[REDACTED]";
export const MAX_DEPTH = 8;
export const MAX_TEXT = 16_384;
/** Trần số phần tử mảng được ghi (phần dư thành một phần tử `…+N`). */
export const MAX_ARRAY = 1000;

const norm = (key: string) =>
  key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");

const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "securehash",
  "connectionstring",
  "databaseurl",
  "cardnumber",
  "sessionid",
  "matkhau",
  "email",
  "phone",
  "sodienthoai",
  "address",
  "diachi",
  "street",
  "cccd",
  "cmnd",
  "nationalid",
  "passport",
  "fullname",
  "firstname",
  "lastname",
  "recipientname",
  "customername",
  "hoten",
  "hovaten",
  "tennguoinhan",
  "dateofbirth",
  "birthday",
  "ngaysinh",
  "clientip",
  "remoteaddr",
  "remoteip",
  "realip",
  "forwardedfor",
  "ipaddress",
];
const SENSITIVE_EXACT = new Set([
  "pwd",
  "pass",
  "auth",
  "session",
  "sid",
  "otp",
  "cvv",
  "cvc",
  "pan",
  "pin",
  "jwt",
  "bearer",
  "signature",
  "sig",
  "sdt",
  "tel",
  "mobile",
  "dob",
  "ten",
  "ip",
]);

/** `true` nếu giá trị của trường tên `key` phải che toàn bộ. */
export function isSensitiveKey(key: string): boolean {
  const k = norm(key);
  if (k === "") return false;
  return SENSITIVE_EXACT.has(k) || SENSITIVE_PARTS.some((p) => k.includes(p));
}

const SECRET_TEXT_RES: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s{1,4}[A-Za-z0-9._~+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|signature|vnp_securehash|otp|sessionid|mat[ _-]?khau)["']?[ \t]{0,3}[=:]/i,
  /:\/\/[^\s/:@]{1,128}:[^\s/@]{1,128}@/,
];
/** Email trong dòng `at`: không chứa `/ ( )` (tránh `node_modules/@scope/pkg/x.js`, `(a@b.c:1:1)` vẫn bắt). */
const EMAIL_RE = /[^\s@/()]{1,64}@[^\s@/()]{1,253}\.[^\s@/()]{1,63}/;

const hasSecretText = (s: string) => SECRET_TEXT_RES.some((re) => re.test(s));

/** Che một chuỗi: cả chuỗi thành `[REDACTED]` nếu giống PII/bí mật. */
export function redactText(raw: string, isStack = false): string {
  const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw;
  const n = text.normalize("NFKC");
  if (hasSecretText(n)) return REDACTED;
  if (!isStack) return looksLikePii(text) ? REDACTED : text;
  return text
    .split("\n")
    .map((line) => {
      const l = line.normalize("NFKC");
      if (/^\s*at\s/.test(l)) return EMAIL_RE.test(l) ? REDACTED : line;
      return looksLikePii(line) ? REDACTED : line;
    })
    .join("\n");
}

/** Che đệ quy mọi giá trị theo tên trường và nội dung; trả bản sao. */
export function redactLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ARRAY).map((v) => redactLog(v, depth + 1, seen));
      if (value.length > MAX_ARRAY) out.push(`…+${value.length - MAX_ARRAY}`);
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactText(k) === REDACTED ? REDACTED : k] = isSensitiveKey(k)
        ? REDACTED
        : redactLog(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
