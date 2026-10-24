import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-029: thêm loại ngoại lệ `notification_failed` (thông báo khách gửi hỏng quá số lần — AT18). Viết tay theo mẫu
 * Migration20261024182619 (db:generate không thấy đổi giá trị enum); `down()` đổi dòng loại mới về `outbox_dead` và giữ
 * loại gốc trong `detail.original_kind` (không xoá dữ liệu vận hành khi lùi).
 */
export class Migration20261024194000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );

    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'outbox_dead' where "kind" = 'notification_failed';`,
    );

    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );

    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead'));`,
    );
  }
}
