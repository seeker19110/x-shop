import { z } from "zod";
import type { ProblemError } from "./problem";

/**
 * Giới hạn danh sách (XC-PERF-006, T-121) — mọi endpoint danh sách có `limit` mặc định + tối đa và phân trang; không
 * endpoint nào trả "tất cả" theo kích thước dữ liệu. Bảng phân loại mọi route GET: integration-tests/http/list-bounds.
 *
 * Hai quy ước có sẵn của dự án (OpenAPI `components.parameters.Limit`, `page_size` của catalog):
 *  - Admin (`limit`/`offset`): 1–100, mặc định 50; offset 0–100.000. Vượt khoảng/không phải số nguyên → 422 (không kẹp
 *    ngầm — nhân viên thấy ngay tham số sai).
 *  - Store công khai (`page_size`, `limit` của danh mục): lớn hơn trần → KẸP về trần (URL cũ/crawler không vỡ); ≤ 0 hoặc
 *    không phải số nguyên → 422 `INVALID_QUERY`.
 */
export const ADMIN_PAGE = { limitDefault: 50, limitMax: 100, offsetMax: 100_000 } as const;

/** Trường zod `limit`/`offset` cho danh sách Admin (dàn vào `z.object({...})`). */
export const adminPageQuery = {
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE.limitMax).default(ADMIN_PAGE.limitDefault),
  offset: z.coerce.number().int().min(0).max(ADMIN_PAGE.offsetMax).default(0),
};

export interface PageWindow {
  limit: number;
  offset: number;
}

/** Số nguyên dương thập phân (tối đa 16 chữ số — dài hơn coi như sai, tránh chuỗi số khổng lồ). */
const DIGITS = /^\d{1,16}$/;

/** Đọc một giá trị query dạng chuỗi (qs có thể sinh mảng/object — coi như sai). */
function single(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? raw : null;
}

/**
 * `limit`/`offset` theo quy ước Store: `limit` > trần → kẹp; `limit` ≤ 0, không phải số nguyên, mảng → lỗi; `offset` âm,
 * không phải số nguyên hoặc > `offsetMax` → lỗi. Lỗi trả về để route gửi 422 cùng các lỗi tham số khác.
 */
export function parseStorePage(
  query: Record<string, unknown>,
  opts: { limitDefault: number; limitMax: number; offsetMax: number },
): { page: PageWindow; errors: ProblemError[] } {
  const errors: ProblemError[] = [];
  let limit = opts.limitDefault;
  let offset = 0;
  const l = single(query.limit);
  if (l !== undefined) {
    if (l !== null && DIGITS.test(l) && Number(l) >= 1) limit = Math.min(Number(l), opts.limitMax);
    else errors.push({ param: "limit", reason: "phải là số nguyên dương" });
  }
  const o = single(query.offset);
  if (o !== undefined) {
    if (o !== null && DIGITS.test(o) && Number(o) <= opts.offsetMax) offset = Number(o);
    else errors.push({ param: "offset", reason: `phải là số nguyên 0–${opts.offsetMax}` });
  }
  return { page: { limit, offset }, errors };
}
