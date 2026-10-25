/**
 * Khoảng báo cáo chọn theo NGÀY (giờ Việt Nam, UTC+7) → cặp mốc `[from, to)` ISO 8601 có múi giờ mà API đòi.
 * `to` là ngày CUỐI được tính (bao gồm) → mốc `to` gửi lên là 00:00 ngày kế tiếp.
 */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value: string): Date | null {
  const m = DATE.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Từ chối ngày không tồn tại (2026-02-31 sẽ tràn sang tháng sau).
  return d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
    ? d
    : null;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export type PeriodResult =
  { ok: true; from: string | null; to: string | null } | { ok: false; error: string };

/** Rỗng = không giới hạn phía đó. Sai định dạng/ngày không tồn tại/đảo ngược → lỗi tiếng Việt. */
export function periodFromDays(fromDay: string, toDay: string): PeriodResult {
  const from = fromDay.trim() ? parseDate(fromDay.trim()) : null;
  const to = toDay.trim() ? parseDate(toDay.trim()) : null;
  if (fromDay.trim() && !from) return { ok: false, error: "Ngày bắt đầu không hợp lệ." };
  if (toDay.trim() && !to) return { ok: false, error: "Ngày kết thúc không hợp lệ." };
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, error: "Ngày bắt đầu phải trước hoặc bằng ngày kết thúc." };
  }
  const next = to ? new Date(to.getTime() + 24 * 3600 * 1000) : null;
  return {
    ok: true,
    from: from ? `${ymd(from)}T00:00:00+07:00` : null,
    to: next ? `${ymd(next)}T00:00:00+07:00` : null,
  };
}
