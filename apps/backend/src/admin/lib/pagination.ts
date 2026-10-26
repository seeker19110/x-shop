/** Số dòng mỗi trang của danh sách Admin (server nhận 1–100). */
export const PAGE_SIZE = 20;

export interface PageInfo {
  /** Số thứ tự dòng đầu/cuối của trang (1-based); trang rỗng → 0/0. */
  from: number;
  to: number;
  count: number;
  /** offset của trang trước/sau; null = không có. */
  prevOffset: number | null;
  nextOffset: number | null;
}

const nonNeg = (n: number): number => (Number.isSafeInteger(n) && n > 0 ? n : 0);

/** Thông tin trang từ `count/limit/offset` server trả. Đầu vào hỏng (âm/NaN) coi như 0, limit hỏng → PAGE_SIZE. */
export function pageInfo(count: number, limit: number, offset: number): PageInfo {
  const total = nonNeg(count);
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_SIZE;
  const start = nonNeg(offset);
  const to = Math.min(start + size, total);
  return {
    from: start < total ? start + 1 : 0,
    to: start < total ? to : 0,
    count: total,
    prevOffset: start > 0 ? Math.max(0, start - size) : null,
    nextOffset: start + size < total ? start + size : null,
  };
}
