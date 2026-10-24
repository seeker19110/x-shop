/** Chuẩn hóa chuỗi người nhập về NFC ở biên trước khi lưu (BASE-DATA-002). */
export function toNfc(input: string): string {
  return input.normalize("NFC");
}

export const MAX_QUERY_LENGTH = 100;

/**
 * Khóa tìm kiếm tiếng Việt có/không dấu (CAT01): bỏ dấu thanh và dấu mũ, `đ→d`, chữ thường, gộp khoảng trắng.
 * "ÁO SƠ MI Lụa" → "ao so mi lua". Ký tự điều khiển và dấu câu (trừ `-` trong SKU) thành khoảng trắng.
 */
export function searchKey(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Chuẩn hóa truy vấn người dùng: NFC, cắt độ dài, rỗng → null. */
export function normalizeQuery(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const q = toNfc(input).trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH).trim();
  return q === "" ? null : q;
}

/** Slug URL: "Áo sơ mi lụa" → "ao-so-mi-lua". */
export function slugify(input: string): string {
  return searchKey(input).replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Mọi từ trong truy vấn (đã chuẩn hóa) đều xuất hiện như tiền tố của một từ trong văn bản. */
export function matchesQuery(text: string, query: string): boolean {
  const words = searchKey(text).split(" ");
  const terms = searchKey(query).split(" ").filter(Boolean);
  return terms.every((t) => words.some((w) => w.startsWith(t)));
}
