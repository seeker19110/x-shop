/** Kết quả nghiệp vụ có mã lỗi ổn định (đặc tả §9.1) — không ném lỗi cho luồng dự kiến. */
export type Result<T, E extends string = string> =
  { ok: true; value: T } | { ok: false; code: E; message: string; field?: string };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E extends string>(code: E, message: string, field?: string): Result<never, E> =>
  field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
