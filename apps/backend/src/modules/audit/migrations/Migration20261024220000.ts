import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Sổ điều chỉnh tồn (T-025, INV03): lý do, người làm, trước/sau, số đang giữ tại thời điểm, khóa chống trùng UNIQUE.
 * Chỉ ghi thêm (cùng trigger với audit_log). CHECK bảo đảm sau = trước + delta và không dưới số đã giữ.
 */
export class Migration20261024220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "inventory_adjustment" (
      "id" text not null,
      "idempotency_key" text not null,
      "payload_hash" text not null,
      "actor_id" text null,
      "inventory_item_id" text not null,
      "location_id" text not null,
      "delta" integer not null check ("delta" <> 0),
      "reason" text not null,
      "note" text null,
      "stocked_before" integer not null,
      "stocked_after" integer not null,
      "reserved_quantity" integer not null,
      "created_at" timestamptz not null default clock_timestamp(),
      constraint "inventory_adjustment_pkey" primary key ("id"),
      constraint "inventory_adjustment_key_unique" unique ("idempotency_key"),
      constraint "inventory_adjustment_math" check ("stocked_after" = "stocked_before" + "delta"),
      constraint "inventory_adjustment_not_below_reserved" check ("stocked_after" >= "reserved_quantity")
    );`);
    this.addSql(
      `create index if not exists "IDX_inventory_adjustment_item" on "inventory_adjustment" ("inventory_item_id", "location_id", "created_at" desc);`,
    );
    this.addSql(`drop trigger if exists "inventory_adjustment_no_update_delete" on "inventory_adjustment";`);
    this
      .addSql(`create trigger "inventory_adjustment_no_update_delete" before update or delete on "inventory_adjustment"
      for each row execute function "x_append_only_guard"();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "inventory_adjustment";`);
  }
}
