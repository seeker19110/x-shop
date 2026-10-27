import { isNonEmpty } from "../../lib/presence";
/**
 * Khôi phục vị trí cuộn của danh sách khi Back từ PDP (CAT03). Chỉ lưu `scrollY` (số) theo URL (đường dẫn + query) ở
 * sessionStorage — theo tab, mất khi đóng tab, KHÔNG chứa dữ liệu cá nhân. Hàm thuần nhận `Storage` để test.
 */
export const SCROLL_STORAGE_KEY = "xs:scroll";
/** Số URL nhớ tối đa (cũ nhất bị bỏ trước) — giữ bộ nhớ nhỏ và bị chặn. */
export const SCROLL_MAX_ENTRIES = 20;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Khóa theo URL: đường dẫn + query, bỏ hash. */
export function scrollKeyOf(loc: { pathname: string; search: string }): string {
  return `${loc.pathname}${loc.search}`;
}

/**
 * Map (không phải object thường): khóa lấy từ URL do người dùng kiểm soát — `__proto__`/`constructor` làm khóa object sẽ
 * chạm prototype thay vì lưu (CodeQL "remote property injection").
 */
function read(storage: Store): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw = storage.getItem(SCROLL_STORAGE_KEY);
    if (!isNonEmpty(raw)) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.set(k, v);
    }
    return out;
  } catch {
    return out;
  }
}

export function saveScroll(storage: Store, key: string, y: number): void {
  if (!Number.isFinite(y) || y < 0) return;
  try {
    const map = read(storage);
    map.delete(key); // đưa lên cuối (mới nhất)
    map.set(key, Math.round(y));
    const keys = [...map.keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - SCROLL_MAX_ENTRIES))) map.delete(k);
    storage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // sessionStorage bị chặn/đầy: bỏ qua, tính năng chỉ là tiện ích
  }
}

/** Vị trí đã lưu của URL; không có/không hợp lệ → null. */
export function loadScroll(storage: Store, key: string): number | null {
  return read(storage).get(key) ?? null;
}
