import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-021: bảng `order_access_redemption` (token tra cứu đơn dùng một lần), `rate_limit_counter` (giới hạn tần suất dùng
 * chung giữa instance) và loại ngoại lệ `refund_request` (khách hủy đơn đã trả tiền). Sinh bằng
 * `medusa db:generate checkout`; `down()` soát tay: ngoại lệ `refund_request` đổi về `checkout_stuck`, giữ loại gốc trong
 * `detail.original_kind` (không xoá dữ liệu vận hành khi lùi).
 */
export class Migration20261024192939 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "rate_limit_counter" drop constraint if exists "rate_limit_counter_bucket_window_unique";`);
    this.addSql(`alter table if exists "order_access_redemption" drop constraint if exists "order_access_redemption_token_hash_unique";`);
    this.addSql(`create table if not exists "order_access_redemption" ("id" text not null, "token_hash" text not null, "order_id" text not null, "expires_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "order_access_redemption_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_access_redemption_deleted_at" ON "order_access_redemption" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_access_redemption_token_hash_unique" ON "order_access_redemption" ("token_hash");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_order_access_redemption_expires_at" ON "order_access_redemption" ("expires_at");`);

    this.addSql(`create table if not exists "rate_limit_counter" ("id" text not null, "bucket" text not null, "window_start" timestamptz not null, "count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "rate_limit_counter_pkey" primary key ("id"), constraint rate_limit_counter_count_nonneg check (count >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rate_limit_counter_deleted_at" ON "rate_limit_counter" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_rate_limit_counter_bucket_window_unique" ON "rate_limit_counter" ("bucket", "window_start");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_rate_limit_counter_window_start" ON "rate_limit_counter" ("window_start");`);

    this.addSql(`alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`);

    this.addSql(`alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead', 'refund_request'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "order_access_redemption" cascade;`);

    this.addSql(`drop table if exists "rate_limit_counter" cascade;`);

    this.addSql(
      `update "ops_exception" set "detail" = coalesce("detail", '{}'::jsonb) || jsonb_build_object('original_kind', "kind"), "kind" = 'checkout_stuck' where "kind" = 'refund_request';`,
    );

    this.addSql(`alter table if exists "ops_exception" drop constraint if exists "ops_exception_kind_check";`);

    this.addSql(`alter table if exists "ops_exception" add constraint "ops_exception_kind_check" check("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck', 'cod_confirm_overdue', 'outbox_dead'));`);
  }

}
