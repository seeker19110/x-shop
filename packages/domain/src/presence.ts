/**
 * BASE-DATA-003: kiểm "có giá trị" tường minh cho định danh, mã, mốc thời gian, chuỗi tuỳ chọn — nơi `""` KHÔNG phải
 * giá trị hợp lệ và được coi như thiếu (giống `if (x)` cũ, nhưng nói rõ ý định và được strict-boolean-expressions
 * chấp nhận). Chỉ nhận chuỗi/Date: số (0 hợp lệ) và boolean phải so sánh trực tiếp (`n !== null`, `b === true`).
 * Khi `""` là giá trị hợp lệ khác với thiếu, đừng dùng hàm này — so `=== null`/`=== undefined`.
 */
export function isNonEmpty<T extends string | Date>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined && v !== "";
}
