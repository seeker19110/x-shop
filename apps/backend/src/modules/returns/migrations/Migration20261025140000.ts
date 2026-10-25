import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-044 — hoàn tiền `failed` không giữ tiền mãi + hủy đơn bởi nhân viên.
 *
 *  - `x_refund.state` thêm `cancelled` (failed → cancelled, kết thúc): nhả số đang giữ để mở yêu cầu MỚI. Người hủy, lúc
 *    hủy, lý do ghi ở `cancelled_by/cancelled_at/cancel_reason`.
 *  - Chỉ mục duy nhất "mỗi yêu cầu trả một hoàn tiền" và "mỗi đơn một hoàn tiền hủy đơn còn hiệu lực" bỏ qua bản ghi
 *    `cancelled` (bản ghi bị hủy không còn hiệu lực — yêu cầu thay thế được phép).
 *  - `x_order_cancel`: mỗi lệnh hủy đơn của nhân viên theo `Idempotency-Key` (UNIQUE) — gửi lại cùng khóa trả lại kết quả
 *    cũ, khác nội dung → 409; lý do bắt buộc.
 *
 * Đường lùi (`down`): bản ghi `cancelled` đổi về `rejected` (cùng nghĩa với sổ tiền: không chi, không giữ) rồi khôi phục
 * ràng buộc/chỉ mục cũ.
 */
export class Migration20261025140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table "x_refund" drop constraint if exists "x_refund_state_check";`);
    this.addSql(`alter table "x_refund" add constraint "x_refund_state_check"
      check ("state" in ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed', 'unknown', 'cancelled'));`);
    this.addSql(`alter table "x_refund"
      add column if not exists "cancelled_by" text null,
      add column if not exists "cancelled_at" timestamptz null,
      add column if not exists "cancel_reason" text null;`);
    this.addSql(`drop index if exists "IDX_x_refund_return_unique";`);
    this.addSql(
      `create unique index if not exists "IDX_x_refund_return_unique" on "x_refund" ("return_id") where "return_id" is not null and "state" <> 'cancelled';`,
    );
    this.addSql(`drop index if exists "IDX_x_refund_cancellation_unique";`);
    this.addSql(
      `create unique index if not exists "IDX_x_refund_cancellation_unique" on "x_refund" ("order_id") where "reason" = 'cancellation' and "state" not in ('rejected', 'cancelled');`,
    );

    this.addSql(`create table if not exists "x_order_cancel" (
      "id" text not null,
      "order_id" text not null,
      "idempotency_key" text not null,
      "payload_hash" text not null,
      "actor_id" text not null,
      "reason" text not null check (length("reason") between 3 and 500),
      "outcome" text not null check ("outcome" in ('cancelled', 'already_cancelled')),
      "from_state" text null,
      "refund_requested" boolean not null default false,
      "refund_id" text null,
      "created_at" timestamptz not null default now(),
      constraint "x_order_cancel_pkey" primary key ("id"),
      constraint "x_order_cancel_idempotency_key_unique" unique ("idempotency_key")
    );`);
    this.addSql(
      `create index if not exists "IDX_x_order_cancel_order" on "x_order_cancel" ("order_id", "created_at");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "x_order_cancel";`);
    this.addSql(
      `update "x_refund" set "state" = 'rejected', "rejected_by" = coalesce("rejected_by", "cancelled_by"), "rejected_at" = coalesce("rejected_at", "cancelled_at"), "reject_reason" = coalesce("reject_reason", "cancel_reason") where "state" = 'cancelled';`,
    );
    this.addSql(`drop index if exists "IDX_x_refund_cancellation_unique";`);
    this.addSql(
      `create unique index if not exists "IDX_x_refund_cancellation_unique" on "x_refund" ("order_id") where "reason" = 'cancellation' and "state" <> 'rejected';`,
    );
    this.addSql(`drop index if exists "IDX_x_refund_return_unique";`);
    this.addSql(
      `create unique index if not exists "IDX_x_refund_return_unique" on "x_refund" ("return_id") where "return_id" is not null;`,
    );
    this.addSql(`alter table "x_refund"
      drop column if exists "cancel_reason",
      drop column if exists "cancelled_at",
      drop column if exists "cancelled_by";`);
    this.addSql(`alter table "x_refund" drop constraint if exists "x_refund_state_check";`);
    this.addSql(`alter table "x_refund" add constraint "x_refund_state_check"
      check ("state" in ('requested', 'approved', 'rejected', 'processing', 'succeeded', 'failed', 'unknown'));`);
  }
}
