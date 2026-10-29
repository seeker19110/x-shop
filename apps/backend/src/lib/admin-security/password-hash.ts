/**
 * Tham số băm mật khẩu của provider `emailpass` (BE-AUTH-001, T-181, ADR-0006, Q-01).
 *
 * Không tự viết mật mã (`custom_crypto=false`): việc băm/kiểm vẫn do `@medusajs/auth-emailpass` 2.22.1 làm bằng thư viện
 * `scrypt-kdf` (OpenSSL `crypto.scrypt` của Node). Ở đây CHỈ chọn `hashConfig` (logN/r/p) truyền vào provider.
 *
 * Mặc định của Medusa là `{ logN: 15, r: 8, p: 1 }` (N = 2^15, 32 MiB) — thấp hơn mức tối thiểu của OWASP Password
 * Storage Cheat Sheet cho scrypt khi không có Argon2id: N = 2^17 (128 MiB), r = 8 (1024 byte), p = 1 (tra trang
 * cheatsheetseries.owasp.org ngày 2026-10-29). Tham số nằm trong header của chuỗi băm (định dạng scrypt-kdf: "scrypt",
 * phiên bản, logN, r, p, salt…) nên hash tạo bằng tham số cũ vẫn kiểm được — không cần migration.
 */
export interface ScryptHashConfig {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

/** Mức tối thiểu OWASP cho scrypt: N = 2^17, r = 8, p = 1. */
export const OWASP_SCRYPT_MIN: ScryptHashConfig = Object.freeze({ logN: 17, r: 8, p: 1 });

/** Mặc định của `@medusajs/auth-emailpass` 2.22.1 khi không truyền `hashConfig` — chỉ để so sánh/kiểm tương thích ngược. */
export const MEDUSA_DEFAULT_SCRYPT: ScryptHashConfig = Object.freeze({ logN: 15, r: 8, p: 1 });

/** `hashConfig` truyền cho provider `emailpass` trong `medusa-config.ts` — mọi môi trường. */
export const EMAILPASS_HASH_CONFIG: ScryptHashConfig = OWASP_SCRYPT_MIN;

/** Cấu hình không thấp hơn mức tối thiểu OWASP (cùng r = 8, N ≥ 2^17, p ≥ 1). */
export function meetsOwaspScryptMinimum(c: ScryptHashConfig): boolean {
  return (
    Number.isInteger(c.logN) &&
    Number.isInteger(c.r) &&
    Number.isInteger(c.p) &&
    c.r >= OWASP_SCRYPT_MIN.r &&
    c.p >= OWASP_SCRYPT_MIN.p &&
    c.logN >= OWASP_SCRYPT_MIN.logN
  );
}
