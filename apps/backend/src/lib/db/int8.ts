import { types } from "@medusajs/framework/pg";

/**
 * Bộ đọc `bigint` (int8) của Postgres thành `number` (T-186, Q-22, DB-MODEL-002, XC-UNITS-005).
 *
 * Cột tiền của module dự án là `bigint` (số nguyên VND). Driver `pg` mặc định trả int8 dạng CHUỖI (an toàn cho số > 2^53)
 * và MikroORM 6.6 không ép về number cho property DML `model.number()` (PostgreSqlConnection chỉ đặt parser cho
 * date/timestamp; Medusa DML 2.22.1 không có kiểu "bigint trả number": `model.number()` = `integer`, `model.bigNumber()` =
 * `numeric` + cột `raw_*`). Không ép thì chuỗi lọt ra API (`"total": "1330000"`) và vào jsonb, so sánh `===` sai, cộng
 * thành nối chuỗi. Nên ép MỘT chỗ, ở tầng driver: mọi đường đọc (service DML, knex thô, MikroORM) cùng nhận `number`.
 *
 * Phạm vi: parser toàn cục của `pg-types` (đối tượng `types` mà `pg` của Medusa/MikroORM/knex cùng dùng — một bản
 * `pg-types` trong cây phụ thuộc; test tích hợp `money-bigint` khẳng định qua service DML thật). Ảnh hưởng mọi giá trị int8
 * trong tiến trình, kể cả của Medusa lõi (vd `count(*)`): đều thành `number`. Giá trị ngoài số nguyên an toàn (|x| > 2^53−1)
 * → `RangeError`, truy vấn bị từ chối (pg 8 bắt lỗi parser theo dòng và reject query) — không làm tròn lặng lẽ.
 * Không đổi: `numeric` (OID 1700, vd `sum(bigint)`) vẫn là chuỗi — mã đọc qua `toVnd`/`Number` như trước; mảng `int8[]`
 * (OID 1016) vẫn là mảng chuỗi — dự án không đọc mảng bigint.
 *
 * Gọi ở `medusa-config.ts` (mọi tiến trình Medusa: server, worker, `medusa exec`, `db:migrate`, runner test tích hợp nạp
 * file này trước khi truy vấn). Gọi nhiều lần vô hại.
 */
export const INT8_OID = types.builtins.INT8;

/** Text int8 từ Postgres → number; ngoài số nguyên an toàn (hoặc không phải số nguyên) → RangeError. */
export function parseInt8(text: string): number {
  const n = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(n)) {
    throw new RangeError(`Giá trị bigint vượt số nguyên an toàn của JavaScript: ${text}`);
  }
  return n;
}

/** Đăng ký parser int8 vào registry `pg-types` (mặc định: bản Medusa dùng). */
export function installInt8Parser(registry: Pick<typeof types, "setTypeParser"> = types): void {
  registry.setTypeParser(INT8_OID, parseInt8);
}
