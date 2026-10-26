import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-074 (DB-PERF-001): index cho ba truy vấn của trang đơn (`presentOrder`, lib/orders/view.ts) mà EXPLAIN trên bộ dữ
 * liệu 200.000 đơn cho thấy quét tuần tự toàn bảng (docs/db/explain/): sự kiện outbox theo đơn (~600k dòng, 46 ms /
 * 13.928 buffer mỗi lần xem đơn), lượt thanh toán theo đơn (index cũ chỉ phủ lượt đang mở), ngoại lệ theo đơn.
 *
 * Index thường (không CONCURRENTLY — migration MikroORM chạy trong giao dịch); bảng còn nhỏ khi chưa ra mắt. Khi bảng
 * production đã lớn mà cần dựng lại: tạo tay `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` trước, migration thành no-op.
 * Không sửa migration cũ; down chỉ xoá index (không mất dữ liệu).
 */
export class Migration20261026174000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_outbox_event_aggregate_id" ON "outbox_event" ("aggregate_id");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_payment_attempt_order_id" ON "payment_attempt" ("order_id");`,
    );
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ops_exception_order_id" ON "ops_exception" ("order_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_outbox_event_aggregate_id";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_payment_attempt_order_id";`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_ops_exception_order_id";`);
  }
}
