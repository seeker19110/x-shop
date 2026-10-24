/**
 * Định dạng VND an toàn cho client bundle: "1.300.000 ₫". Phản chiếu `formatVnd` của `@x-shop/domain`
 * (xem `format-vnd.test.ts`) — domain không import được ở client vì kéo cả gói (~139 KiB gzip) vào JS tải đầu.
 * Số không nguyên/không an toàn → ném lỗi (không che dữ liệu hỏng).
 */
const vnd = new Intl.NumberFormat("vi-VN");

export function formatVnd(amount: number): string {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`amount phải là số nguyên VND an toàn, nhận ${String(amount)}`);
  }
  return `${vnd.format(amount)} ₫`;
}
