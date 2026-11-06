import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-196 (DB-PERF-008) — tham số autovacuum riêng cho `audit_log` (bảng của module audit; ba bảng của module checkout:
 * Migration20261031090000 — nguồn PostgreSQL 16 tra 2026-10-31 và mặc định toàn cụm ghi đầy đủ ở đó). Chỉ đổi storage
 * parameter (`pg_class.reloptions`), không đổi dữ liệu/cột/ràng buộc/trigger.
 *
 * `audit_log` là append-only (trigger chặn UPDATE/DELETE — Migration20261024210100): dead tuple chỉ đến từ INSERT bị
 * rollback, nên vacuum theo dead tuple hiếm khi cần; vacuum theo số dòng chèn (autovacuum_vacuum_insert_scale_factor,
 * mặc định 0.2 — giữ nguyên) lo visibility map/đóng băng XID. Truy vấn tra cứu lọc theo `action`/`created_at desc` gần
 * đây nên thống kê cần theo kịp dòng mới.
 *  - vacuum 0.1 (thay 0.2): dọn sớm hơn phần dead tuple hiếm hoi trên bảng lớn dần mãi;
 *  - analyze 0.05 (thay 0.1): bảng lớn dần thì 10 % là rất nhiều dòng mới chưa vào thống kê;
 *  - cost_limit 200 (= vacuum_cost_limit mặc định): bảng không bao giờ xoá dòng, lượt vacuum/đóng băng giữ nhẹ như
 *    mặc định — đặt riêng chỉ để worker trên bảng này không bị chia nhỏ ngân sách (bảng có cost_limit riêng ra khỏi
 *    phép chia giữa các worker, routine-vacuuming §25.1.6) và có giá trị tường minh để `check-vacuum`/RUNBOOK tham chiếu.
 * Tài liệu chính thức không cho con số khuyến nghị theo bảng: đây là lựa chọn kỹ thuật, đổi bằng migration mới khi có số
 * đo production.
 *
 * `lock_timeout` cục bộ (SHARE UPDATE EXCLUSIVE xung đột với vacuum chống wraparound đang chạy): quá 5 s → lỗi, chạy lại.
 * Lũy đẳng. Đường lùi (`down`): `RESET` đúng ba tham số — về mặc định toàn cụm.
 */
const PARAMS =
  "autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_limit";

export class Migration20261031090100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "audit_log" set (autovacuum_vacuum_scale_factor = 0.1, autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_cost_limit = 200);`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`alter table if exists "audit_log" reset (${PARAMS});`);
  }
}
