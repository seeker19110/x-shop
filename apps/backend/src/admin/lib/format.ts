/**
 * Định dạng hiển thị cho Admin — thuần, không phụ thuộc React. Không tính tiền ở UI (chỉ hiển thị số server trả).
 * `@x-shop/domain` không nạp được vào bundle Admin (index kéo `node:fs`), nên `formatVnd` ở đây là bản Intl y hệt
 * `formatVnd` của domain; test `format.unit.spec.ts` khoá hai bản cùng đầu ra.
 */
const vnd = new Intl.NumberFormat("vi-VN");

/** "1.300.000 ₫"; `null`/`undefined`/số không nguyên an toàn → "—" (không bịa 0). */
export function formatVnd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isSafeInteger(amount)) return "—";
  return `${vnd.format(amount)} ₫`;
}

/** Tuổi (giây) → "5 giây" | "12 phút" | "3 giờ 5 phút" | "2 ngày 4 giờ". Âm/NaN/null → "—". */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} giờ ${m % 60} phút` : `${h} giờ`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} ngày ${h % 24} giờ` : `${d} ngày`;
}

/** ISO 8601 → giờ Việt Nam ngắn gọn; rỗng/không hợp lệ → "—". */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}
