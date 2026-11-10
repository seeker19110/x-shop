import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// @migration-contract: T-186 (Q-22, DB-MODEL-002) mở rộng cột tiền int4 → bigint tại chỗ; cột tạo ở Migration20261025120000. Chưa có dữ liệu thật, int4 → bigint không mất giá trị.

/**
 * T-186 (Q-22; DB-MODEL-002) — `x_settlement_line.amount` từ `integer` sang `bigint`: cột tiền cuối cùng của module
 * `settlement` còn int4 (các cột tiền khác của module đã là bigint từ Migration20261025120000). Bảng append-only
 * (trigger `x_settlement_line_no_update_delete` chặn UPDATE/DELETE theo dòng) — ALTER TYPE viết lại bảng ở mức DDL, không
 * kích trigger dòng. Trần nghiệp vụ một dòng chứng từ vẫn là `SETTLEMENT_CONFIG.maxAmountVnd` (csv.ts), không đổi ở đây.
 * Đọc: `toVnd` (service.ts) ép chuỗi int8 → number có Number.isSafeInteger.
 *
 * down() (đường lùi): trả về `integer` NHƯNG dừng (raise) nếu có giá trị ngoài miền int4 — không cắt dữ liệu.
 */
export class Migration20261106100300 extends Migration {
  override async up(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(`alter table if exists "x_settlement_line" alter column "amount" type bigint;`);
  }

  override async down(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(`do $$
begin
  if exists (select 1 from "x_settlement_line" where "amount" not between -2147483648 and 2147483647) then
    raise exception 'T-186 down(): có giá trị tiền ngoài miền integer — không hạ kiểu (sẽ mất dữ liệu)';
  end if;
end
$$;`);
    this.addSql(`alter table if exists "x_settlement_line" alter column "amount" type integer;`);
  }
}
