import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005, review) — `x_settlement_discrepancy.actual_amount` luôn có số ở mọi đường ghi
 * (`SettlementModuleService`: chênh lệch từ dòng chứng từ ghi số tiền của dòng; `missing` ghi 0) → `NOT NULL`.
 *
 * Chạy được trên dữ liệu có sẵn: đếm dòng NULL trước — còn dòng NULL thì dừng kèm số dòng, KHÔNG tự điền (số tiền đối
 * soát phải do người xác nhận). Migration chạy trong giao dịch → `SET NOT NULL` giữ ACCESS EXCLUSIVE trong lúc quét bảng
 * (bảng nhỏ khi chưa ra mắt). `down()` bỏ NOT NULL — dữ liệu không đổi.
 */
export class Migration20261026220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`do $$
declare n bigint;
begin
  select count(*) into n from "x_settlement_discrepancy" where "actual_amount" is null;
  if n > 0 then
    raise exception 'T-101: % dòng của x_settlement_discrepancy có actual_amount NULL — sửa dữ liệu trước khi migrate', n using errcode = '23502';
  end if;
end $$;`);
    this.addSql(`alter table "x_settlement_discrepancy" alter column "actual_amount" set not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "x_settlement_discrepancy" alter column "actual_amount" drop not null;`);
  }
}
