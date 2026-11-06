/**
 * Bản sao `isNonEmpty` của `@x-shop/domain` an toàn cho client component (import GIÁ TRỊ từ domain kéo mã crypto vào
 * bundle — xem client-bundle.test.ts); presence.test.ts khoá hai bản cùng kết quả.
 * BASE-DATA-003: "có giá trị" tường minh cho định danh/mã/chuỗi tuỳ chọn nơi `""` coi như thiếu. Không dùng cho số
 * (0 hợp lệ) hay boolean.
 */
export function isNonEmpty<T extends string | Date>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined && v !== "";
}
