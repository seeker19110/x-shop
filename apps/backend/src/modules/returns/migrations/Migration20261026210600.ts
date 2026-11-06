import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005) — `x_order_cancel.from_state` (trạng thái đơn lúc nhân viên hủy; null khi lệnh hủy lặp trên đơn
 * đã hủy) thiếu CHECK tập giá trị (do `node scripts/ops/check-schema.mjs` tìm ra). Tập = `ORDER_STATES` của
 * packages/domain (cùng danh sách CHECK `order_finance.state`) — ghi cứng vì migration là ảnh chụp bất biến; thêm trạng
 * thái đơn mới = migration mới cho cả hai bảng.
 *
 * Kiểm dữ liệu trước (dừng kèm số dòng vi phạm, không tự sửa), rồi `NOT VALID` + `VALIDATE`. `down()` gỡ CHECK — dữ
 * liệu không đổi.
 */
const CHECK = {
  table: "x_order_cancel",
  name: "x_order_cancel_from_state_check",
  expr: `"from_state" is null or "from_state" in ('preparing', 'awaiting_payment', 'placed', 'confirmed', 'cancelled', 'completed')`,
};

export class Migration20261026210600 extends Migration {
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
