import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// @migration-contract: T-186 (Q-22, DB-MODEL-002) mở rộng cột tiền int4 → bigint tại chỗ; cột tạo ở Migration20261024193304. Chưa có dữ liệu thật, int4 → bigint không mất giá trị.

/**
 * T-186 (Q-22; DB-MODEL-002) — cột tiền của module `shipping` từ `integer` sang `bigint` (số nguyên VND):
 * `shipment.cod_amount`, `shipment.shipping_fee`, `shipment.cod_reported_amount`. Một câu ALTER cho cả ba cột (viết lại
 * bảng một lần). Lý do ALTER tại chỗ và cách đọc int8: xem checkout/Migration20261106100000.
 *
 * down() (đường lùi): trả về `integer` NHƯNG dừng (raise) nếu có giá trị ngoài miền int4 — không cắt dữ liệu.
 */
const COLS = ["cod_amount", "shipping_fee", "cod_reported_amount"] as const;

const alter = (type: "bigint" | "integer"): string =>
  `alter table if exists "shipment" ${COLS.map((c) => `alter column "${c}" type ${type}`).join(", ")};`;

const INT4_GUARD = `do $$
begin
  if exists (select 1 from "shipment" where ${COLS.map((c) => `"${c}" not between -2147483648 and 2147483647`).join(" or ")}) then
    raise exception 'T-186 down(): có giá trị tiền ngoài miền integer — không hạ kiểu (sẽ mất dữ liệu)';
  end if;
end
$$;`;

export class Migration20261106100100 extends Migration {
  override async up(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(alter("bigint"));
  }

  override async down(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(INT4_GUARD);
    this.addSql(alter("integer"));
  }
}
