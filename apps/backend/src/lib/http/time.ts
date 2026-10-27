import { z } from "zod";

/**
 * Thời điểm ở biên API (XC-UNITS-001): CHỈ nhận RFC 3339 `date-time` có offset — `Z` hoặc `±hh:mm` (RFC 3339 §5.6).
 * Chuỗi không offset (`2026-10-25T10:00:00`, chỉ ngày) bị từ chối thay vì đoán múi giờ; không dùng `Date.parse`
 * trên đầu vào thô vì nó đọc chuỗi không offset theo múi giờ máy chủ và cho tràn ngày (30/02 → 02/03).
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export const RFC3339_EXAMPLE = "2026-10-25T00:00:00+07:00";

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** RFC 3339 có offset → Date; mọi dạng khác (không offset, ngày/giờ không tồn tại, giây 60) → null. */
export function parseRfc3339(raw: string): Date | null {
  const m = RFC3339.exec(raw);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (m[7] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Schema zod cho tham số/trường thời điểm: chuỗi RFC 3339 có offset → `Date`. */
export const rfc3339Instant = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const d = parseRfc3339(v);
    if (!d) {
      ctx.addIssue({ code: "custom", message: `RFC 3339 có offset (Z hoặc ±hh:mm), vd. ${RFC3339_EXAMPLE}` });
      return z.NEVER;
    }
    return d;
  });
