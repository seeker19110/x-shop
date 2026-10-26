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
