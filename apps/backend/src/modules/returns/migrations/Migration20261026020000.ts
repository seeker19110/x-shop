import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-054 — chỉ mục cho hàng đợi hoàn tiền của Admin (T-049): `listRefundsByState` lọc `state` rồi sắp theo `created_at`
 * (cũ nhất trước) trên mọi đơn; `IDX_x_refund_order` (order_id, created_at) không phục vụ được truy vấn này.
 *
 * Đường lùi (`down`): gỡ chỉ mục — dữ liệu không đổi.
 */
export class Migration20261026020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create index if not exists "IDX_x_refund_state_created" on "x_refund" ("state", "created_at");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_x_refund_state_created";`);
  }
}
