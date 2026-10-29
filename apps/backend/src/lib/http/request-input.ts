import type { MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { sendProblem, zodErrors, type ProblemError } from "./problem";

/**
 * Cửa duy nhất để route dự án đọc `req.params` / `req.query` (BASE-SEC-001, BE-API-003): mọi giá trị đi qua schema zod
 * (kiểu, độ dài, định dạng) rồi mới vào logic. Express/qs trả `string | string[] | object` — `?a=1&a=2` là mảng,
 * `?a[b]=1` là object — nên schema chuỗi (`z.string()`) từ chối chúng thay vì `String()` ép thành "1,2".
 * Kiểm tĩnh ở `integration-tests/http/route-inventory.spec.ts` đỏ nếu route truy cập thẳng `req.params`/`req.query`.
 *
 * Kết quả dạng `{ ok }` (không ném) để mỗi route giữ cách ánh xạ lỗi riêng: tham số đường dẫn sai dạng →
 * `sendParamNotFound` (404 như không tồn tại); query/thân sai → `sendInvalidInput` (422 `VALIDATION`, đặc tả §9.1).
 */
export type InputResult<T> = { ok: true; data: T } | { ok: false; errors: ProblemError[] };

function run<T extends z.ZodType>(schema: T, input: unknown): InputResult<z.output<T>> {
  const parsed = schema.safeParse(input ?? {});
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, errors: zodErrors(parsed.error.issues) };
}

/** Tham số đường dẫn (`:id`…) theo schema. */
export const readParams = <T extends z.ZodType>(req: { params?: unknown }, schema: T) =>
  run(schema, req.params);

/** Query string theo schema (khoá lạ bị bỏ — dùng `z.strictObject` khi cần từ chối). */
export const readQuery = <T extends z.ZodType>(req: { query?: unknown }, schema: T) => run(schema, req.query);

/**
 * Túi query cho bộ đọc có allowlist riêng (`parseListingQuery`, `parseStorePage`, chữ ký VNPAY): schema ở đây chỉ bảo
 * đảm "một object khoá-chuỗi"; từng giá trị (chuỗi/mảng/object) do bộ đọc kia kiểm — chúng loại giá trị không phải chuỗi.
 */
export const QueryBag = z.record(z.string(), z.unknown());
export const readQueryBag = (req: { query?: unknown }) => run(QueryBag, req.query);

/** Chuỗi đơn (không nhận mảng/object), không rỗng, tối đa `max` ký tự — mẫu cho `:id`. */
export const pathId = (max = 128) => z.string().min(1).max(max);

/** `{ id }` — tham số đường dẫn `:id` chuẩn. */
export const IdParams = z.object({ id: pathId() });

/**
 * Tham số đường dẫn sai hình dạng (rỗng, quá dài, không đúng mẫu) không thể khớp tài nguyên nào → 404 NOT_FOUND như id
 * không tồn tại (hành vi từ trước đây; không phân biệt "sai dạng" với "không có" để không thành kênh dò).
 */
export const sendParamNotFound = (res: MedusaResponse): void =>
  sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy tài nguyên");

/** 422 VALIDATION problem+json cho đầu vào sai (cùng mã với lỗi thân/query của các route khác). */
export const sendInvalidInput = (res: MedusaResponse, errors: ProblemError[]): void =>
  sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", errors);
