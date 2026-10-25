import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-012: thêm loại ngoại lệ `cod_confirm_overdue` (job cod-confirm-timeout) và `outbox_dead` (outbox hỏng quá số lần).
 * Sinh bằng `medusa db:generate checkout`; `down()` soát tay: dòng thuộc loại mới được đổi về `checkout_stuck` và giữ
 * loại gốc trong `detail.original_kind` (không xoá dữ liệu vận hành khi lùi).
 */
export class Migration20261024182619 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );

    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'checkout_stuck' where "kind" in ('cod_confirm_overdue', 'outbox_dead');`,
    );

    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );

    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck'));`,
    );
  }
}
