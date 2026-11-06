import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005) — `catalog_index_dirty.attempts` (số lần đồng bộ thất bại, T-061) thiếu CHECK cận dưới (do
 * `node scripts/ops/check-schema.mjs` tìm ra). Bộ đếm bắt đầu 0, chỉ tăng.
 *
 * Kiểm dữ liệu trước (dừng kèm số dòng vi phạm, không tự sửa — bảng tái tạo được: xoá dòng lỗi rồi rebuild), rồi
 * `NOT VALID` + `VALIDATE`. `down()` gỡ CHECK — dữ liệu không đổi.
 */
const CHECK = {
  table: "catalog_index_dirty",
  name: "catalog_index_dirty_attempts_nonneg",
  expr: `"attempts" >= 0`,
};

export class Migration20261026210400 extends Migration {
  override async up(): Promise<void> {
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
  }
}
