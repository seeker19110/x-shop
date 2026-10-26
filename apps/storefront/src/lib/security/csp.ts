/**
 * Content Security Policy của storefront (SEC05, T-11): nonce mới mỗi request + `'strict-dynamic'` — script chỉ chạy khi
 * mang nonce (Next tự gắn nonce cho script framework/RSC khi đọc header CSP của request — docs Next 16 "Content Security
 * Policy") hoặc được script có nonce nạp. KHÔNG `'unsafe-inline'` cho script. Yêu cầu trang render động (root layout gọi
 * `connection()`).
 *
 * Nới có chủ đích: `style-src 'unsafe-inline'` — `next/image` sinh thuộc tính `style` (không gắn nonce được); chèn CSS
 * không thực thi mã. `'unsafe-eval'` chỉ ở `next dev` (React dùng eval cho stack lỗi dev).
 */
export interface CspOptions {
  nonce: string;
  dev: boolean;
  production: boolean;
}

export function buildCsp({ nonce, dev, production }: CspOptions): string {
  const directives: Array<[string, string]> = [
    ["default-src", "'self'"],
    ["script-src", `'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "'self' data: blob:"],
    ["font-src", "'self'"],
    ["connect-src", dev ? "'self' ws: wss:" : "'self'"],
    ["manifest-src", "'self'"],
    ["worker-src", "'self'"],
    ["frame-src", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  const out = directives.map(([k, v]) => `${k} ${v}`);
  if (production) out.push("upgrade-insecure-requests");
  return out.join("; ");
}

/** Nonce 128 bit ngẫu nhiên (Web Crypto), base64. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";
