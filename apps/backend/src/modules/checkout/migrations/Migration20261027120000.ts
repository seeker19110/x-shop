import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-156 (D-095): thêm `catalog_compensation_failed` vào CHECK `ops_exception.kind` — bù trừ workflow
 * `set-product-fashion` (khôi phục thuộc tính/bảng size/số đo người mẫu) lỗi, sản phẩm có thể lệch trạng thái → mở
 * ngoại lệ loại này (chỉ id + mã lỗi, không giá trị). Không sửa migration cũ; dựng lại CHECK với đủ mọi giá trị.
 */
export class Migration20261027120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request', 'catalog_index_mismatch', 'catalog_compensation_failed'));`,
    );
  }

  override async down(): Promise<void> {
    // CHECK cũ không nhận kind mới → dựng lại thẳng sẽ lỗi nếu đã có dòng `catalog_compensation_failed`. Đường lùi giữ
    // dữ liệu như Migration20261026030000: chuyển các dòng đó về `outbox_dead`, loại gốc lưu ở detail.original_kind
    // (không xoá dòng nào; up() lại không tự khôi phục loại — đọc detail.original_kind nếu cần).
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'outbox_dead' where "kind" = 'catalog_compensation_failed';`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request', 'catalog_index_mismatch'));`,
    );
  }
}
