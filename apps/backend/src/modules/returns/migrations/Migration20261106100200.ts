import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// @migration-contract: T-186 (Q-22, DB-MODEL-002) mở rộng cột tiền int4 → bigint tại chỗ; cột tạo ở Migration20261025010000, trigger ở Migration20261026010000. Chưa có dữ liệu thật, int4 → bigint không mất giá trị.

/**
 * T-186 (Q-22; DB-MODEL-002) — cột tiền của module `returns` từ `integer` sang `bigint` (số nguyên VND):
 * `x_refund.amount`, `x_return_line.refund_amount`. Lý do ALTER tại chỗ: xem checkout/Migration20261106100000.
 *
 * `x_refund.amount` nằm trong điều kiện WHEN của trigger `x_refund_order_lock_upd` (Migration20261026010000) — PostgreSQL
 * không cho đổi kiểu cột dùng trong định nghĩa trigger, nên gỡ trigger, đổi kiểu, rồi tạo lại NGUYÊN VĂN trong cùng
 * migration (một giao dịch: không có lúc nào UPDATE x_refund chạy mà thiếu trigger). Hàm `x_refund_require_order_lock`
 * không đổi.
 *
 * down() (đường lùi): trả về `integer` NHƯNG dừng (raise) nếu có giá trị ngoài miền int4 — không cắt dữ liệu.
 */
const DROP_TRIGGER = `drop trigger if exists "x_refund_order_lock_upd" on "x_refund";`;
const CREATE_TRIGGER = `create trigger "x_refund_order_lock_upd" before update on "x_refund"
      for each row
      when (
        new."state" not in ('rejected', 'cancelled')
        and (
          old."state" in ('rejected', 'cancelled')
          or new."amount" > old."amount"
          or new."order_id" is distinct from old."order_id"
        )
      )
      execute function "x_refund_require_order_lock"();`;

const alter = (type: "bigint" | "integer"): string[] => [
  DROP_TRIGGER,
  `alter table if exists "x_refund" alter column "amount" type ${type};`,
  CREATE_TRIGGER,
  `alter table if exists "x_return_line" alter column "refund_amount" type ${type};`,
];

const INT4_GUARD = `do $$
begin
  if exists (select 1 from "x_refund" where "amount" not between -2147483648 and 2147483647)
     or exists (select 1 from "x_return_line" where "refund_amount" not between -2147483648 and 2147483647)
  then
    raise exception 'T-186 down(): có giá trị tiền ngoài miền integer — không hạ kiểu (sẽ mất dữ liệu)';
  end if;
end
$$;`;

export class Migration20261106100200 extends Migration {
  override async up(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    for (const sql of alter("bigint")) this.addSql(sql);
  }

  override async down(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(INT4_GUARD);
    for (const sql of alter("integer")) this.addSql(sql);
  }
}
