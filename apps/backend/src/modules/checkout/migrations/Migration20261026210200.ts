import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-005) — cột trạng thái thiếu CHECK tập giá trị do `node scripts/ops/check-schema.mjs` tìm ra ở module
 * checkout (model DML khai `model.text()`; CHECK chỉ thêm ở DB, model/snapshot giữ nguyên):
 *  - `payment_ledger.state`: sổ tiền chỉ ghi khoản ĐÃ xác minh — mọi đường ghi (applyCapture, syncLedger của hoàn
 *    tiền, seed vận hành/diễn tập) đều ghi `succeeded`; khoản đang xử lý nằm ở payment_attempt/x_refund. Thêm giá trị
 *    mới = migration mới.
 *  - `webhook_inbox.source`: `NotificationSource` = `ipn` (IPN VNPAY) | `query` (querydr — job/nút "Kiểm tra lại").
 *
 * Chạy được trên dữ liệu có sẵn: kiểm trước (dừng kèm số dòng vi phạm, không tự sửa dữ liệu), rồi `NOT VALID` +
 * `VALIDATE`. `down()` gỡ CHECK — dữ liệu không đổi.
 */
const CHECKS = [
  { table: "payment_ledger", name: "payment_ledger_state_check", expr: `"state" in ('succeeded')` },
  { table: "webhook_inbox", name: "webhook_inbox_source_check", expr: `"source" in ('ipn', 'query')` },
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

export class Migration20261026210200 extends Migration {
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
