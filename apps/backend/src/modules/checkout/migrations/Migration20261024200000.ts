import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Hợp nhất danh sách `ops_exception.kind` sau khi hai nhánh song song (T-021: `refund_request`, T-029:
 * `notification_failed`) cùng dựng lại CHECK — migration chạy sau (20261024194000) làm mất `refund_request`.
 * Không sửa migration cũ; migration này dựng lại CHECK với đủ mọi giá trị.
 */
export class Migration20261024200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request'));`,
    );
  }

  override async down(): Promise<void> {
    // Đường lùi giữ dữ liệu: dòng `refund_request` chuyển về `outbox_dead`, loại gốc lưu ở detail.original_kind.
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'outbox_dead' where "kind" = 'refund_request';`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed'));`,
    );
  }
}
