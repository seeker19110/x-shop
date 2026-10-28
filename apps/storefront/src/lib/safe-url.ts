import { getVnpayExtraOrigins } from "./env/public";

/**
 * Allowlist scheme cho URL từ dữ liệu ngoài (FE-SEC-002, SEC-WEB-004): chỉ http/https/mailto/tel hoặc đường dẫn
 * tương đối cùng origin ("/..."). Trả về chuỗi đã chuẩn hóa, hoặc null nếu không an toàn.
 *
 * Từ chối thay vì "làm sạch": trình duyệt bỏ ký tự điều khiển/tab/xuống dòng trong scheme ("java\tscript:"), nên
 * mọi ký tự điều khiển (C0, DEL, C1), khoảng trắng và ký tự định dạng vô hình ở giữa đều bị loại; khoảng trắng ASCII
 * hai đầu được cắt.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function isUnsafeChar(code: number): boolean {
  return (
    code <= 0x20 || // C0 + dấu cách
    (code >= 0x7f && code <= 0xa0) || // DEL, C1, NBSP
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200f) || // khoảng trắng Unicode, ZWSP/ZWNJ/ZWJ, LRM/RLM
    (code >= 0x2028 && code <= 0x202f) || // LS/PS, bidi override, NNBSP
    (code >= 0x205f && code <= 0x2064) ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export function safeUrl(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const value = input.replace(/^ +| +$/g, "");
  if (value === "") return null;
  for (let i = 0; i < value.length; i += 1) {
    if (isUnsafeChar(value.charCodeAt(i))) return null;
  }

  if (value.startsWith("/")) {
    // "//host" (protocol-relative) và "\" bị trình duyệt hiểu thành origin khác.
    if (value.startsWith("//") || value.includes("\\")) return null;
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // URL() đã hạ chữ thường scheme ("JAVASCRIPT:" thành "javascript:"), nên allowlist không phân biệt hoa/thường.
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  return url.href;
}

/** Liên kết điều hướng: URL không an toàn thì trỏ "#" (không điều hướng đi đâu) thay vì render scheme nguy hiểm. */
export function safeHref(input: string | null | undefined): string {
  return safeUrl(input) ?? "#";
}

/** Ảnh dự phòng cùng origin khi URL ảnh từ dữ liệu ngoài không an toàn. */
export const IMAGE_FALLBACK_SRC = "/icons/icon.svg";

/** Ảnh nội dung: chỉ http(s)/đường dẫn cùng origin (không mailto/tel); không an toàn thì dùng ảnh dự phòng. */
export function safeImgSrc(input: string | null | undefined): string {
  const url = safeUrl(input);
  if (url === null || url.startsWith("mailto:") || url.startsWith("tel:")) return IMAGE_FALLBACK_SRC;
  return url;
}

/**
 * `srcSet` (danh sách "url 640w, url 1x"): giữ từng ứng viên có URL an toàn (như safeImgSrc) và descriptor đúng dạng;
 * ứng viên xấu bị bỏ; không còn ứng viên nào thì dùng ảnh dự phòng. Tách theo ", " (URL có dấu phẩy trần không hợp lệ ở đây).
 */
export function safeSrcSet(input: string | null | undefined): string {
  if (typeof input !== "string") return IMAGE_FALLBACK_SRC;
  const kept: string[] = [];
  for (const raw of input.split(/,\s+/)) {
    const m = /^(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?$/.exec(raw.trim());
    if (m === null) continue;
    const url = safeUrl(m[1]);
    if (url === null || url.startsWith("mailto:") || url.startsWith("tel:")) continue;
    kept.push(m[2] === undefined ? url : `${url} ${m[2]}`);
  }
  return kept.length === 0 ? IMAGE_FALLBACK_SRC : kept.join(", ");
}

/** Cổng VNPAY (sandbox.vnpayment.vn, pay.vnpay.vn…): khớp đúng tên miền gốc hoặc subdomain thật, không khớp chuỗi con. */
export const VNPAY_HOST_SUFFIXES: readonly string[] = ["vnpayment.vn", "vnpay.vn"];

/**
 * URL thanh toán do server cấp nhưng vẫn không tin tuyệt đối: qua `safeUrl`, chỉ https, không userinfo/cổng lạ,
 * host phải là (sub)domain của allowlist VNPAY hoặc origin khớp chính xác với NEXT_PUBLIC_VNPAY_EXTRA_ORIGINS. Sai thì null (không chuyển hướng).
 */
export function safePaymentUrl(
  input: string | null | undefined,
  hostSuffixes: readonly string[] = VNPAY_HOST_SUFFIXES,
  extraOrigins: readonly string[] = getVnpayExtraOrigins(),
): string | null {
  const safe = safeUrl(input);
  if (safe === null) return null;
  let url: URL;
  try {
    url = new URL(safe);
  } catch {
    return null; // đường dẫn tương đối "/..." không phải cổng thanh toán
  }
  if (url.username !== "" || url.password !== "") return null;
  // Origin bổ sung (dev/E2E, D-131): khớp chính xác scheme+host+port.
  if (extraOrigins.includes(url.origin)) return url.href;
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname;
  return hostSuffixes.some((s) => host === s || host.endsWith(`.${s}`)) ? url.href : null;
}
