import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005) — `inventory_adjustment.reserved_quantity` (số đang giữ tại thời điểm điều chỉnh) thiếu CHECK
 * cận dưới (do `node scripts/ops/check-schema.mjs` tìm ra). Số giữ không bao giờ âm; cùng CHECK
 * `stocked_after >= reserved_quantity` sẵn có → tồn sau điều chỉnh cũng không âm. `stocked_before` không thêm CHECK:
 * ảnh chụp giá trị native của Medusa (không ràng buộc cận dưới) — có lý do trong allowlist của script.
 *
 * Bảng chỉ ghi thêm (trigger chặn UPDATE/DELETE) — thêm ràng buộc không sửa dòng nào. Kiểm dữ liệu trước (dừng kèm số
 * dòng vi phạm), rồi `NOT VALID` + `VALIDATE`. `down()` gỡ CHECK — dữ liệu không đổi.
 */
const CHECK = {
  table: "inventory_adjustment",
  name: "inventory_adjustment_reserved_nonneg",
  expr: `"reserved_quantity" >= 0`,
};

export class Migration20261026210300 extends Migration {
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
