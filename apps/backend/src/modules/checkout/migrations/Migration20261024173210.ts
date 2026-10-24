import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Module `checkout` — tạo 10 bảng (sinh bằng `medusa db:generate checkout` từ model DSL, đã soát tay).
 * - Ràng buộc nghiệp vụ ở DB: UNIQUE / partial UNIQUE / CHECK (BASE-DATA-010) — test: integration-tests/http/checkout-module.
 * - Tiền: cột `integer` nguyên VND (DSL `model.number()`), không float. Lý do không dùng `bigint`: pg trả int8 dạng chuỗi
 *   và MikroORM 6 không ép về number (PostgreSqlConnection không đặt type parser cho int8) → rủi ro cộng chuỗi trong mã
 *   tiền. Trần 2.147.483.647 đồng/giá trị được chặn sớm ở báo giá (422 LIMIT, `MAX_MONEY_VND`).
 * - Đường lùi: `down()` xoá các bảng mới (module mới, chưa có dữ liệu thật ở lần áp đầu).
 */
export class Migration20261024173210 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "webhook_inbox" drop constraint if exists "webhook_inbox_provider_event_unique";`,
    );
    this.addSql(
      `alter table if exists "payment_ledger" drop constraint if exists "payment_ledger_provider_txn_kind_unique";`,
    );
    this.addSql(
      `alter table if exists "payment_attempt" drop constraint if exists "payment_attempt_order_active_unique";`,
    );
    this.addSql(
      `alter table if exists "payment_attempt" drop constraint if exists "payment_attempt_txn_ref_unique";`,
    );
    this.addSql(
      `alter table if exists "outbox_event" drop constraint if exists "outbox_event_event_key_unique";`,
    );
    this.addSql(
      `alter table if exists "order_finance" drop constraint if exists "order_finance_display_ref_unique";`,
    );
    this.addSql(
      `alter table if exists "order_finance" drop constraint if exists "order_finance_order_id_unique";`,
    );
    this.addSql(
      `alter table if exists "ops_exception" drop constraint if exists "ops_exception_dedupe_unique";`,
    );
    this.addSql(
      `alter table if exists "coupon_usage" drop constraint if exists "coupon_usage_code_order_unique";`,
    );
    this.addSql(
      `alter table if exists "coupon_usage" drop constraint if exists "coupon_usage_code_attempt_unique";`,
    );
    this.addSql(
      `alter table if exists "checkout_attempt" drop constraint if exists "checkout_attempt_cart_version_active_unique";`,
    );
    this.addSql(
      `alter table if exists "checkout_attempt" drop constraint if exists "checkout_attempt_idempotency_unique";`,
    );
    this.addSql(
      `alter table if exists "cart_version" drop constraint if exists "cart_version_cart_id_unique";`,
    );
    this.addSql(
      `create table if not exists "cart_version" ("id" text not null, "cart_id" text not null, "version" integer not null, "fingerprint" text not null, "frozen_by_attempt" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "cart_version_pkey" primary key ("id"), constraint cart_version_version_pos check (version >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_cart_version_deleted_at" ON "cart_version" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cart_version_cart_id_unique" ON "cart_version" ("cart_id");`,
    );

    this.addSql(
      `create table if not exists "checkout_attempt" ("id" text not null, "cart_id" text not null, "cart_version" integer not null, "idempotency_scope" text not null, "idempotency_key" text not null, "payload_hash" text not null, "quote_id" text not null, "state" text check ("state" in ('preparing', 'ready', 'failed', 'compensated')) not null default 'preparing', "order_id" text null, "quote" jsonb null, "payment_method" text check ("payment_method" in ('cod', 'vnpay')) not null, "hold_expires_at" timestamptz null, "error_code" text null, "error_detail" jsonb null, "lease_until" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "checkout_attempt_pkey" primary key ("id"), constraint checkout_attempt_cart_version_pos check (cart_version >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_checkout_attempt_deleted_at" ON "checkout_attempt" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_checkout_attempt_idempotency_unique" ON "checkout_attempt" ("idempotency_scope", "idempotency_key");`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_checkout_attempt_cart_version_active_unique" ON "checkout_attempt" ("cart_id", "cart_version") WHERE state IN ('preparing', 'ready') AND deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_checkout_attempt_state_lease" ON "checkout_attempt" ("state", "lease_until");`,
    );

    this.addSql(
      `create table if not exists "checkout_quote" ("id" text not null, "cart_id" text not null, "cart_version" integer not null, "payment_method" text check ("payment_method" in ('cod', 'vnpay')) not null, "discount_code" text null, "address" jsonb not null, "breakdown" jsonb not null, "total" integer not null, "expires_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "checkout_quote_pkey" primary key ("id"), constraint checkout_quote_total_nonneg check (total >= 0), constraint checkout_quote_cart_version_pos check (cart_version >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_checkout_quote_deleted_at" ON "checkout_quote" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_checkout_quote_cart_id" ON "checkout_quote" ("cart_id");`);

    this.addSql(
      `create table if not exists "coupon_usage" ("id" text not null, "promotion_code" text not null, "promotion_id" text null, "checkout_attempt_id" text not null, "order_id" text null, "state" text check ("state" in ('held', 'used', 'released')) not null default 'held', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "coupon_usage_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_coupon_usage_deleted_at" ON "coupon_usage" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_coupon_usage_code_attempt_unique" ON "coupon_usage" ("promotion_code", "checkout_attempt_id");`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_coupon_usage_code_order_unique" ON "coupon_usage" ("promotion_code", "order_id") WHERE order_id IS NOT NULL AND deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_coupon_usage_code_state" ON "coupon_usage" ("promotion_code", "state");`,
    );

    this.addSql(
      `create table if not exists "ops_exception" ("id" text not null, "kind" text check ("kind" in ('late_payment', 'overpayment', 'payment_unknown', 'refund_unknown', 'webhook_rejected', 'checkout_stuck')) not null, "dedupe_key" text null, "order_id" text null, "amount" integer null, "state" text check ("state" in ('open', 'in_progress', 'resolved')) not null default 'open', "owner" text null, "priority" text check ("priority" in ('low', 'normal', 'high', 'urgent')) not null default 'normal', "due_at" timestamptz null, "detail" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ops_exception_pkey" primary key ("id"), constraint ops_exception_amount_nonneg check (amount IS NULL OR amount >= 0));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ops_exception_deleted_at" ON "ops_exception" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ops_exception_dedupe_unique" ON "ops_exception" ("dedupe_key") WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_ops_exception_state_due" ON "ops_exception" ("state", "due_at");`,
    );

    this.addSql(
      `create table if not exists "order_finance" ("id" text not null, "order_id" text not null, "display_ref" text not null, "checkout_attempt_id" text not null, "cart_id" text not null, "state" text check ("state" in ('preparing', 'awaiting_payment', 'placed', 'confirmed', 'cancelled', 'completed')) not null, "total" integer not null, "payment_method" text check ("payment_method" in ('cod', 'vnpay')) not null, "hold_expires_at" timestamptz null, "cod_confirm_by" timestamptz null, "policy_version" text not null, "quote" jsonb not null, "address" jsonb not null, "contact" jsonb not null, "version" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "order_finance_pkey" primary key ("id"), constraint order_finance_total_nonneg check (total >= 0), constraint order_finance_version_pos check (version >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_order_finance_deleted_at" ON "order_finance" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_finance_order_id_unique" ON "order_finance" ("order_id");`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_order_finance_display_ref_unique" ON "order_finance" ("display_ref");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_order_finance_state_hold" ON "order_finance" ("state", "hold_expires_at");`,
    );

    this.addSql(
      `create table if not exists "outbox_event" ("id" text not null, "event_key" text not null, "aggregate_id" text not null, "type" text not null, "payload" jsonb not null, "state" text check ("state" in ('pending', 'sent', 'failed', 'dead')) not null default 'pending', "attempts" integer not null default 0, "next_attempt_at" timestamptz not null, "last_error" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "outbox_event_pkey" primary key ("id"), constraint outbox_event_attempts_nonneg check (attempts >= 0));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_outbox_event_deleted_at" ON "outbox_event" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_outbox_event_event_key_unique" ON "outbox_event" ("event_key");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_outbox_event_state_next" ON "outbox_event" ("state", "next_attempt_at");`,
    );

    this.addSql(
      `create table if not exists "payment_attempt" ("id" text not null, "order_id" text not null, "provider" text not null, "txn_ref" text not null, "amount" integer not null, "state" text check ("state" in ('created', 'pending', 'authorized', 'captured', 'failed', 'unknown')) not null default 'created', "payment_url" text null, "expires_at" timestamptz not null, "provider_txn_no" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_attempt_pkey" primary key ("id"), constraint payment_attempt_amount_pos check (amount > 0));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_attempt_deleted_at" ON "payment_attempt" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_attempt_txn_ref_unique" ON "payment_attempt" ("txn_ref");`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_attempt_order_active_unique" ON "payment_attempt" ("order_id") WHERE state IN ('created', 'pending', 'unknown') AND deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "payment_ledger" ("id" text not null, "order_id" text not null, "kind" text check ("kind" in ('capture', 'refund')) not null, "amount" integer not null, "provider" text not null, "provider_txn_id" text not null, "refund_id" text null, "state" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "payment_ledger_pkey" primary key ("id"), constraint payment_ledger_amount_pos check (amount > 0));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_ledger_deleted_at" ON "payment_ledger" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_ledger_provider_txn_kind_unique" ON "payment_ledger" ("provider", "provider_txn_id", "kind");`,
    );
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_payment_ledger_order_id" ON "payment_ledger" ("order_id");`);

    this.addSql(
      `create table if not exists "webhook_inbox" ("id" text not null, "provider" text not null, "event_key" text not null, "source" text not null default 'ipn', "payload" jsonb not null, "payload_hash" text not null, "verified" boolean not null default false, "result" jsonb null, "processed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "webhook_inbox_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_webhook_inbox_deleted_at" ON "webhook_inbox" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_webhook_inbox_provider_event_unique" ON "webhook_inbox" ("provider", "event_key");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "cart_version" cascade;`);

    this.addSql(`drop table if exists "checkout_attempt" cascade;`);

    this.addSql(`drop table if exists "checkout_quote" cascade;`);

    this.addSql(`drop table if exists "coupon_usage" cascade;`);

    this.addSql(`drop table if exists "ops_exception" cascade;`);

    this.addSql(`drop table if exists "order_finance" cascade;`);

    this.addSql(`drop table if exists "outbox_event" cascade;`);

    this.addSql(`drop table if exists "payment_attempt" cascade;`);

    this.addSql(`drop table if exists "payment_ledger" cascade;`);

    this.addSql(`drop table if exists "webhook_inbox" cascade;`);
  }
}
