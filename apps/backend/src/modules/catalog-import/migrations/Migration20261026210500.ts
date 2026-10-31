import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005) — bộ đếm dòng của job nhập CSV thiếu CHECK (do `node scripts/ops/check-schema.mjs` tìm ra):
 * `rows_total >= 0` và `0 <= rows_valid <= rows_total` (dòng hợp lệ là tập con của dòng đọc được —
 * lib/catalog/import.ts). Model DML giữ nguyên; CHECK chỉ thêm ở DB.
 *
 * Kiểm dữ liệu trước (dừng kèm số dòng vi phạm, không tự sửa), rồi `NOT VALID` + `VALIDATE`. `down()` gỡ CHECK — dữ
 * liệu không đổi.
 */
const CHECKS = [
  { table: "catalog_import_job", name: "catalog_import_job_rows_total_nonneg", expr: `"rows_total" >= 0` },
  {
    table: "catalog_import_job",
    name: "catalog_import_job_rows_valid_range",
    expr: `"rows_valid" >= 0 and "rows_valid" <= "rows_total"`,
  },
] as const;

/** Dừng migrate (giữ nguyên dữ liệu) khi còn dòng vi phạm — vận hành sửa dữ liệu có chủ đích rồi chạy lại. */
const guard = (table: string, name: string, expr: string) => `do $$
declare n bigint;
begin
  select count(*) into n from "${table}" where not (${expr});
  if n > 0 then
    raise exception 'T-101: % dòng của ${table} vi phạm ${name} — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`;

export class Migration20261026210500 extends Migration {
  override async up(): Promise<void> {
    for (const c of CHECKS) {
      this.addSql(guard(c.table, c.name, c.expr));
      this.addSql(`alter table "${c.table}" drop constraint if exists "${c.name}";`);
      this.addSql(`alter table "${c.table}" add constraint "${c.name}" check (${c.expr}) not valid;`);
      this.addSql(`alter table "${c.table}" validate constraint "${c.name}";`);
    }
  }

  override async down(): Promise<void> {
    for (const c of CHECKS) this.addSql(`alter table "${c.table}" drop constraint if exists "${c.name}";`);
  }
}
