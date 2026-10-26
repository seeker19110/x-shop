import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-059 (D-040): thêm `catalog_index_mismatch` vào CHECK `ops_exception.kind` — read model catalog dựng lệch
 * (SKU có giá niêm yết mà không ra giá bán) thì rebuild giữ bảng cũ và mở ngoại lệ loại này.
 * Không sửa migration cũ; dựng lại CHECK với đủ mọi giá trị.
 */
export class Migration20261026030000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request', 'catalog_index_mismatch'));`,
    );
  }

  override async down(): Promise<void> {
    // Đường lùi giữ dữ liệu: dòng `catalog_index_mismatch` chuyển về `outbox_dead`, loại gốc lưu ở detail.original_kind
    // (không xoá dòng nào; up() lại không tự khôi phục loại — đọc detail.original_kind nếu cần).
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'outbox_dead' where "kind" = 'catalog_index_mismatch';`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request'));`,
    );
  }
}
