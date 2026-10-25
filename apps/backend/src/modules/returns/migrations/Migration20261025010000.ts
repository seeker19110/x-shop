import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Đổi trả theo dòng + hoàn tiền (T-027, POST03, INV04, §6.5, AT15–AT17). Tiền: `integer` nguyên VND (D-009, trần
 * 2.147.483.647 đ). Tên bảng có tiền tố `x_` — Medusa đã có bảng `return`/`refund` của module order/payment.
 *
 * Bất biến ở DB:
 *  - mỗi yêu cầu/hoàn tiền có `idempotency_key` UNIQUE — gửi lại cùng khóa không tạo bản ghi thứ hai;
 *  - dòng trả: 0 < quantity; received ≤ quantity; khi đã kiểm định restock + damaged + rejected = received;
 *  - hoàn tiền: amount > 0; `provider_request_id` UNIQUE (retry dùng CÙNG mã, không tạo refund mới — §6.5);
 *    mỗi yêu cầu trả tối đa một hoàn tiền; mỗi đơn tối đa một hoàn tiền hủy đơn còn hiệu lực.
 * Tổng hoàn ≤ đã thu kiểm trong transaction dưới khóa advisory theo đơn (service) — không biểu diễn được bằng CHECK.
 */
export class Migration20261025010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "x_return" (
      "id" text not null,
      "order_id" text not null,
      "kind" text not null check ("kind" in ('return', 'exchange')),
      "state" text not null default 'requested'
        check ("state" in ('requested', 'approved', 'rejected', 'received', 'inspected', 'closed')),
      "reason" text not null
        check ("reason" in ('wrong_size', 'defective', 'not_as_described', 'changed_mind', 'other')),
      "note" text null,
      "channel" text not null check ("channel" in ('customer', 'staff')),
      "requested_by" text null,
      "idempotency_key" text not null,
      "payload_hash" text not null,
      "decided_by" text null,
      "decided_at" timestamptz null,
      "decision_note" text null,
      "received_by" text null,
      "received_at" timestamptz null,
      "inspected_by" text null,
      "inspected_at" timestamptz null,
      "closed_at" timestamptz null,
      "replacement_order_id" text null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "x_return_pkey" primary key ("id"),
      constraint "x_return_idempotency_key_unique" unique ("idempotency_key")
    );`);
    this.addSql(`create index if not exists "IDX_x_return_order" on "x_return" ("order_id", "created_at");`);
    this.addSql(`create index if not exists "IDX_x_return_state" on "x_return" ("state", "created_at");`);

    this.addSql(`create table if not exists "x_return_line" (
      "id" text not null,
      "return_id" text not null,
      "order_line_item_id" text not null,
      "variant_id" text null,
      "quantity" integer not null check ("quantity" > 0),
      "exchange_variant_id" text null,
      "size_chart" jsonb null,
      "received_quantity" integer null,
      "restock_quantity" integer null,
      "damaged_quantity" integer null,
      "rejected_quantity" integer null,
      "refund_amount" integer null,
      "inspection_note" text null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "x_return_line_pkey" primary key ("id"),
      constraint "x_return_line_return_fk" foreign key ("return_id") references "x_return" ("id") on delete restrict,
      constraint "x_return_line_unique" unique ("return_id", "order_line_item_id"),
      constraint "x_return_line_received_range"
        check ("received_quantity" is null or ("received_quantity" >= 0 and "received_quantity" <= "quantity")),
      constraint "x_return_line_inspection_sum" check (
        ("restock_quantity" is null and "damaged_quantity" is null and "rejected_quantity" is null)
        or ("received_quantity" is not null and "restock_quantity" >= 0 and "damaged_quantity" >= 0
            and "rejected_quantity" >= 0
            and "restock_quantity" + "damaged_quantity" + "rejected_quantity" = "received_quantity")
      ),
      constraint "x_return_line_refund_nonneg" check ("refund_amount" is null or "refund_amount" >= 0)
    );`);
    this.addSql(
      `create index if not exists "IDX_x_return_line_item" on "x_return_line" ("order_line_item_id");`,
    );

    this.addSql(`create table if not exists "x_refund" (
      "id" text not null,
      "order_id" text not null,
      "return_id" text null,
      "reason" text not null
        check ("reason" in ('return', 'cancellation', 'overpayment', 'late_payment', 'other')),
      "amount" integer not null check ("amount" > 0),
      "method" text not null check ("method" in ('provider', 'manual')),
      "provider" text not null,
      "capture_ref" text null,
      "state" text not null default 'requested'
        check ("state" in ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed', 'unknown')),
      "approval_required" boolean not null,
      "requested_by" text not null,
      "approved_by" text null,
      "approved_at" timestamptz null,
      "rejected_by" text null,
      "rejected_at" timestamptz null,
      "reject_reason" text null,
      "executed_by" text null,
      "provider_request_id" text not null,
      "provider_ref" text null,
      "evidence_ref" text null,
      "attempts" integer not null default 0 check ("attempts" >= 0),
      "last_error" text null,
      "note" text null,
      "idempotency_key" text not null,
      "payload_hash" text not null,
      "succeeded_at" timestamptz null,
      "created_at" timestamptz not null default now(),
      "updated_at" timestamptz not null default now(),
      constraint "x_refund_pkey" primary key ("id"),
      constraint "x_refund_idempotency_key_unique" unique ("idempotency_key"),
      constraint "x_refund_provider_request_unique" unique ("provider_request_id"),
      constraint "x_refund_provider_needs_capture" check ("method" <> 'provider' or "capture_ref" is not null)
    );`);
    this.addSql(`create index if not exists "IDX_x_refund_order" on "x_refund" ("order_id", "created_at");`);
    this.addSql(
      `create unique index if not exists "IDX_x_refund_return_unique" on "x_refund" ("return_id") where "return_id" is not null;`,
    );
    this.addSql(
      `create unique index if not exists "IDX_x_refund_cancellation_unique" on "x_refund" ("order_id") where "reason" = 'cancellation' and "state" <> 'rejected';`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "x_refund";`);
    this.addSql(`drop table if exists "x_return_line";`);
    this.addSql(`drop table if exists "x_return";`);
  }
}
