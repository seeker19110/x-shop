/**
 * Chuẩn hoá chữ cho ô nhập (thuần, không phụ thuộc): NFC, bỏ khoảng trắng đầu/cuối, gộp khoảng trắng liên tiếp.
 * Dùng chung cho form ở trình duyệt và kiểm lại ở server (`@x-shop/domain/validation`, FE-FORM-001).
 */
export function normalizeText(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Số ký tự người đọc thấy (code point), không phải số đơn vị UTF-16 — giới hạn "tối đa N ký tự" đếm theo đây. */
export function charLength(s: string): number {
  return [...s].length;
}
