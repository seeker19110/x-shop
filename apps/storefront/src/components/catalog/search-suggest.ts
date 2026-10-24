/**
 * Logic thuần của hộp gợi ý tìm kiếm (không phụ thuộc React/DOM) — có test riêng.
 * Phản chiếu quy tắc của `@x-shop/domain` (`normalizeQuery`: NFC, gọn khoảng trắng, ≤ 100 ký tự) vì client không
 * được import giá trị từ domain (D-008).
 */
export const SUGGEST_DEBOUNCE_MS = 250;
export const SUGGEST_MAX = 8;
export const SUGGEST_MIN_CHARS = 2;

/** Chuẩn hóa truy vấn gõ vào: NFC, gọn khoảng trắng, cắt `maxLength` theo ký tự (không cắt giữa cặp thay thế). */
export function normalizeTyped(input: string, maxLength: number): string {
  const s = input.normalize("NFC").trim().replace(/\s+/g, " ");
  return [...s].slice(0, maxLength).join("").trim();
}

export function shouldSuggest(q: string): boolean {
  return [...q].length >= SUGGEST_MIN_CHARS;
}

/** Danh sách gợi ý hợp lệ từ phản hồi: chuỗi không rỗng, bỏ trùng, tối đa `SUGGEST_MAX`. */
export function sanitizeSuggestions(raw: unknown): string[] {
  const list = (raw as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
    if (out.length === SUGGEST_MAX) break;
  }
  return out;
}

/** Vị trí gợi ý đang chọn sau phím mũi tên: -1 = chưa chọn (đang ở ô nhập); quay vòng hai đầu. */
export function moveActive(current: number, key: "ArrowDown" | "ArrowUp", count: number): number {
  if (count <= 0) return -1;
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}
