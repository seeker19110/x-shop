import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-097 (OPS-COST-004): circuit breaker chi phí của job nền/outbox.
 *  - Bảng `job_breaker`: trạng thái breaker DÙNG CHUNG mọi bản sao (closed/open/half_open, số lỗi liên tiếp, hạn nguội,
 *    hạn lượt thử) — không giữ trong bộ nhớ tiến trình (ARC-RES-005). Bảng mới, rỗng: tạo tức thì, không khoá bảng cũ.
 *  - Thêm `job_circuit_open` vào CHECK `ops_exception.kind` (breaker mở → ngoại lệ vận hành). Không sửa migration cũ;
 *    dựng lại CHECK với đủ mọi giá trị.
 */
export class Migration20261027160101 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "job_breaker" ("id" text not null, "breaker_key" text not null, "state" text check ("state" in ('closed', 'open', 'half_open')) not null default 'closed', "consecutive_failures" integer not null default 0, "last_failed_event_id" text null, "open_until" timestamptz null, "probe_until" timestamptz null, "trip_reason" text check ("trip_reason" in ('consecutive_failures', 'budget_exhausted')) null, "trip_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "job_breaker_pkey" primary key ("id"), constraint job_breaker_consecutive_failures_nonneg check (consecutive_failures >= 0), constraint job_breaker_trip_count_nonneg check (trip_count >= 0), constraint job_breaker_open_has_until check (state <> 'open' OR open_until IS NOT NULL), constraint job_breaker_half_open_has_probe check (state <> 'half_open' OR probe_until IS NOT NULL));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_job_breaker_deleted_at" ON "job_breaker" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_job_breaker_key_unique" ON "job_breaker" ("breaker_key");`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request', 'catalog_index_mismatch', 'catalog_compensation_failed', 'job_circuit_open'));`,
    );
  }

  override async down(): Promise<void> {
    // CHECK cũ không nhận kind mới → giữ dữ liệu như Migration20261027120000: chuyển các dòng `job_circuit_open` về
    // `outbox_dead`, loại gốc lưu ở detail.original_kind (không xoá dòng nào). Bảng `job_breaker` chỉ chứa trạng thái
    // tạm (không có dòng = closed) → xoá được; chỉ mất hạn nguội đang chạy.
    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'outbox_dead' where "kind" = 'job_circuit_open';`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'notification_failed', 'refund_request', 'catalog_index_mismatch', 'catalog_compensation_failed'));`,
    );
    this.addSql(`drop table if exists "job_breaker" cascade;`);
  }
}
