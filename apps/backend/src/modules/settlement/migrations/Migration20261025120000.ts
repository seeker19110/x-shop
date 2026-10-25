import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Đối soát COD/sao kê (T-028, §5.5, AT14). Tiền dòng chứng từ: `integer` nguyên VND (D-009, trần 2.147.483.647 đ);
 * tổng batch và số chênh lệch cộng dồn dùng `bigint` (tổng nhiều dòng có thể vượt trần integer) — service ép kiểu và
 * kiểm Number.isSafeInteger khi đọc.
 *
 * Bất biến ở DB:
 *  - batch: UNIQUE(source, content_hash) — cùng chứng từ nhập lại (kể cả hai request đồng thời) chỉ MỘT batch;
 *    UNIQUE(source, external_ref) khi có mã batch của hãng;
 *  - batch, dòng chứng từ và lịch sử chênh lệch CHỈ GHI THÊM (trigger chặn UPDATE/DELETE) — chứng từ tiền không sửa
 *    được sau khi nhập; sai thì nhập batch điều chỉnh/giải quyết chênh lệch có lý do;
 *  - khóa ngoại tới batch DEFERRABLE INITIALLY DEFERRED: service chèn dòng/chênh lệch trước, dòng batch (kèm tóm tắt
 *    đã chốt) sau cùng trong cùng transaction — kiểm lúc commit;
 *  - chênh lệch: `dedupe_key` UNIQUE (một dòng chứng từ → tối đa một chênh lệch; "thiếu" tối đa một lần mỗi đối tượng);
 *    đã giải quyết ⇔ có `resolved_at`.
 * Không khóa ngoại sang bảng của module khác (shipment/payment_ledger/x_refund) — ranh giới module Medusa.
 */
export class Migration20261025120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "x_settlement_batch" (
      "id" text not null,
      "source" text not null check ("source" in ('ghn_cod', 'vnpay')),
      "content_hash" text not null check ("content_hash" ~ '^[0-9a-f]{64}$'),
      "external_ref" text null,
      "period_end" timestamptz null,
      "row_count" integer not null check ("row_count" > 0),
      "total_amount" bigint not null check ("total_amount" >= 0),
      "summary" jsonb not null default '{}'::jsonb,
      "imported_by" text not null,
      "created_at" timestamptz not null default now(),
      constraint "x_settlement_batch_pkey" primary key ("id"),
      constraint "x_settlement_batch_hash_unique" unique ("source", "content_hash")
    );`);
    this.addSql(
      `create unique index if not exists "IDX_x_settlement_batch_external_ref" on "x_settlement_batch" ("source", "external_ref") where "external_ref" is not null;`,
    );
    this.addSql(
      `create index if not exists "IDX_x_settlement_batch_created" on "x_settlement_batch" ("created_at" desc, "id" desc);`,
    );

    this.addSql(`create table if not exists "x_settlement_line" (
      "id" text not null,
      "batch_id" text not null,
      "source" text not null check ("source" in ('ghn_cod', 'vnpay')),
      "line_no" integer not null check ("line_no" >= 2),
      "reference" text not null,
      "type" text not null check ("type" in ('cod', 'payment', 'refund')),
      "amount" integer not null check ("amount" >= 0),
      "occurred_at" timestamptz not null,
      "target_kind" text null check ("target_kind" in ('shipment', 'capture', 'refund')),
      "target_id" text null,
      "order_id" text null,
      "result" text not null
        check ("result" in ('matched', 'amount_mismatch', 'unexpected', 'overpaid', 'late_after_cancel')),
      "expected_amount" bigint null,
      "difference" bigint null,
      "created_at" timestamptz not null default now(),
      constraint "x_settlement_line_pkey" primary key ("id"),
      constraint "x_settlement_line_batch_fk" foreign key ("batch_id") references "x_settlement_batch" ("id")
        on delete restrict deferrable initially deferred,
      constraint "x_settlement_line_unique" unique ("batch_id", "line_no"),
      constraint "x_settlement_line_target_pair" check (("target_kind" is null) = ("target_id" is null))
    );`);
    this.addSql(
      `create index if not exists "IDX_x_settlement_line_target" on "x_settlement_line" ("source", "target_id") where "target_id" is not null;`,
    );
    this.addSql(
      `create index if not exists "IDX_x_settlement_line_occurred" on "x_settlement_line" ("occurred_at");`,
    );

    this.addSql(`create table if not exists "x_settlement_discrepancy" (
      "id" text not null,
      "kind" text not null
        check ("kind" in ('missing', 'amount_mismatch', 'unexpected', 'overpaid', 'late_after_cancel')),
      "state" text not null default 'open' check ("state" in ('open', 'resolved')),
      "priority" text not null default 'normal' check ("priority" in ('low', 'normal', 'high', 'urgent')),
      "source" text not null check ("source" in ('ghn_cod', 'vnpay')),
      "reference" text not null,
      "target_kind" text null check ("target_kind" in ('shipment', 'capture', 'refund')),
      "target_id" text null,
      "order_id" text null,
      "expected_amount" bigint null,
      "actual_amount" bigint null,
      "difference" bigint null,
      "amount" bigint not null check ("amount" >= 0),
      "batch_id" text not null,
      "line_id" text null,
      "dedupe_key" text not null,
      "owner" text null,
      "resolved_by" text null,
      "resolved_at" timestamptz null,
      "resolution_note" text null,
      "evidence_ref" text null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "x_settlement_discrepancy_pkey" primary key ("id"),
      constraint "x_settlement_discrepancy_dedupe_unique" unique ("dedupe_key"),
      constraint "x_settlement_discrepancy_batch_fk" foreign key ("batch_id") references "x_settlement_batch" ("id")
        on delete restrict deferrable initially deferred,
      constraint "x_settlement_discrepancy_line_fk" foreign key ("line_id") references "x_settlement_line" ("id") on delete restrict,
      constraint "x_settlement_discrepancy_resolved" check (("state" = 'resolved') = ("resolved_at" is not null))
    );`);
    this.addSql(
      `create index if not exists "IDX_x_settlement_discrepancy_open" on "x_settlement_discrepancy" ("state", "priority", "created_at");`,
    );
    this.addSql(
      `create index if not exists "IDX_x_settlement_discrepancy_target" on "x_settlement_discrepancy" ("source", "target_id") where "state" = 'open';`,
    );

    this.addSql(`create table if not exists "x_settlement_discrepancy_event" (
      "id" text not null,
      "discrepancy_id" text not null,
      "action" text not null check ("action" in ('opened', 'auto_resolved', 'resolved')),
      "actor_type" text not null check ("actor_type" in ('user', 'system')),
      "actor_id" text null,
      "batch_id" text null,
      "note" text null,
      "data" jsonb null,
      "created_at" timestamptz not null default clock_timestamp(),
      constraint "x_settlement_discrepancy_event_pkey" primary key ("id"),
      constraint "x_settlement_discrepancy_event_fk" foreign key ("discrepancy_id") references "x_settlement_discrepancy" ("id") on delete restrict
    );`);
    this.addSql(
      `create index if not exists "IDX_x_settlement_discrepancy_event" on "x_settlement_discrepancy_event" ("discrepancy_id", "created_at");`,
    );

    // Chỉ ghi thêm: hàm riêng của module (không phụ thuộc thứ tự migration của module audit).
    this
      .addSql(`create or replace function "x_settlement_append_only"() returns trigger language plpgsql as $$
      begin
        raise exception 'bảng % chỉ cho ghi thêm (append-only)', TG_TABLE_NAME using errcode = '42501';
      end;
    $$;`);
    for (const table of ["x_settlement_batch", "x_settlement_line", "x_settlement_discrepancy_event"]) {
      this.addSql(`drop trigger if exists "${table}_no_update_delete" on "${table}";`);
      this.addSql(`create trigger "${table}_no_update_delete" before update or delete on "${table}"
        for each row execute function "x_settlement_append_only"();`);
    }
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "x_settlement_discrepancy_event";`);
    this.addSql(`drop table if exists "x_settlement_discrepancy";`);
    this.addSql(`drop table if exists "x_settlement_line";`);
    this.addSql(`drop table if exists "x_settlement_batch";`);
    this.addSql(`drop function if exists "x_settlement_append_only"() cascade;`);
  }
}
