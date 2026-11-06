import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-004, DB-MODEL-005) — vi phạm do `node scripts/ops/check-schema.mjs` tìm ra ở module settlement:
 *  - FK `x_settlement_discrepancy.batch_id` và `.line_id` (ON DELETE RESTRICT) không có index → kiểm FK khi xoá
 *    batch/dòng chứng từ phải quét cả bảng chênh lệch; màn chênh lệch theo batch cũng cần. Thêm index thường.
 *  - `x_settlement_discrepancy.actual_amount` (tiền thực nhận theo chứng từ, `missing` ghi 0) không có CHECK ≥ 0.
 *    `expected_amount` KHÔNG thêm CHECK: chênh lệch `late_after_cancel` ghi phần còn phải thu (phải thu − đã thu), âm
 *    được khi đã thu vượt — có lý do trong allowlist của script.
 *
 * Index thường (không CONCURRENTLY — migration chạy trong giao dịch); bảng nhỏ khi chưa ra mắt. CHECK được kiểm dữ liệu
 * trước (dừng kèm số dòng vi phạm, không tự sửa), rồi `NOT VALID` + `VALIDATE`. `down()` gỡ index/CHECK — dữ liệu không đổi.
 */
const CHECK = {
  table: "x_settlement_discrepancy",
  name: "x_settlement_discrepancy_actual_nonneg",
  expr: `"actual_amount" is null or "actual_amount" >= 0`,
};

export class Migration20261026210100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create index if not exists "IDX_x_settlement_discrepancy_batch" on "x_settlement_discrepancy" ("batch_id");`,
    );
    this.addSql(
      `create index if not exists "IDX_x_settlement_discrepancy_line" on "x_settlement_discrepancy" ("line_id");`,
    );
    this.addSql(`do $$
declare n bigint;
begin
  select count(*) into n from "${CHECK.table}" where not (${CHECK.expr});
  if n > 0 then
    raise exception 'T-101: % dòng của ${CHECK.table} vi phạm ${CHECK.name} — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`);
    this.addSql(`alter table "${CHECK.table}" drop constraint if exists "${CHECK.name}";`);
    this.addSql(
      `alter table "${CHECK.table}" add constraint "${CHECK.name}" check (${CHECK.expr}) not valid;`,
    );
    this.addSql(`alter table "${CHECK.table}" validate constraint "${CHECK.name}";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "${CHECK.table}" drop constraint if exists "${CHECK.name}";`);
    this.addSql(`drop index if exists "IDX_x_settlement_discrepancy_line";`);
    this.addSql(`drop index if exists "IDX_x_settlement_discrepancy_batch";`);
  }
}
