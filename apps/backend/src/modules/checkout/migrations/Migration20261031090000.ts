import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-196 (DB-PERF-008) — tham số autovacuum riêng cho ba bảng ghi nhiều của module checkout (bảng `audit_log` của module
 * audit: Migration20261031090100). Chỉ đổi storage parameter (`pg_class.reloptions`), không đổi dữ liệu/cột/ràng buộc.
 *
 * Nguồn (PostgreSQL 16, tra 2026-10-31):
 *  - postgresql.org/docs/16/runtime-config-autovacuum.html — mặc định toàn cụm: autovacuum_vacuum_threshold 50,
 *    autovacuum_vacuum_scale_factor 0.2, autovacuum_analyze_threshold 50, autovacuum_analyze_scale_factor 0.1,
 *    autovacuum_vacuum_cost_delay 2 ms, autovacuum_vacuum_cost_limit -1 (= vacuum_cost_limit);
 *  - postgresql.org/docs/16/runtime-config-resource.html — vacuum_cost_limit mặc định 200;
 *  - postgresql.org/docs/16/routine-vacuuming.html §25.1.6 — ngưỡng vacuum = threshold + scale_factor × số dòng (analyze
 *    tương tự); bảng có `autovacuum_vacuum_cost_limit` riêng KHÔNG tham gia chia ngân sách I/O giữa các worker;
 *  - postgresql.org/docs/16/sql-createtable.html (Storage Parameters) — các tham số đặt được theo bảng;
 *  - postgresql.org/docs/16/sql-altertable.html — `SET (…)` cho tham số autovacuum lấy khoá SHARE UPDATE EXCLUSIVE
 *    (không chặn SELECT/INSERT/UPDATE/DELETE); `RESET (…)` trả về mặc định.
 * Tài liệu chính thức chỉ cho mặc định và công thức, KHÔNG cho con số khuyến nghị theo bảng: các giá trị dưới đây là lựa
 * chọn kỹ thuật theo kiểu ghi của từng bảng (đọc từ mã), đổi bằng migration mới khi có số đo production.
 *
 *  - outbox_event: mỗi dòng INSERT rồi UPDATE ≥ 2 lần (nhận lease rồi sent; mỗi lượt lỗi tạm thêm lease + failed, tối
 *    đa 8 lượt); không job nào xoá dòng.
 *    Job dispatch 10 s quét chỉ mục bán phần theo `state`/`next_attempt_at` — dead tuple làm chậm lượt nhận, thống kê
 *    cũ làm planner đoán sai số dòng `pending`. vacuum 0.02 (2 % thay vì 20 %), analyze 0.02.
 *  - rate_limit_counter: UPSERT `count = count + 1` mỗi request bị giới hạn (một dòng nóng / bucket / cửa sổ) và job dọn
 *    xoá cửa sổ cũ — số dòng nhỏ, tỉ lệ cập nhật/dòng cao nhất. vacuum 0.01, analyze 0.05 (phân bố ít đổi).
 *  - webhook_inbox: INSERT mỗi IPN rồi UPDATE một lần (`processed_at`, `result`). vacuum 0.05, analyze 0.05.
 *  - cost_limit 400 (= 2 × vacuum_cost_limit mặc định) cho cả ba: bảng nhỏ, cần dọn xong nhanh; vì bảng có cost_limit
 *    riêng ra khỏi phép chia ngân sách, trần I/O tệ nhất là 400 / 2 ms mỗi worker đang chạy trên ba bảng này.
 *
 * `lock_timeout` cục bộ: SHARE UPDATE EXCLUSIVE xung đột với VACUUM/ANALYZE đang chạy — autovacuum thường bị huỷ
 * nhường khoá, nhưng vacuum chống wraparound thì không; chờ quá 5 s → lỗi (chạy lại) thay vì treo deploy.
 * Lũy đẳng: SET cùng giá trị lặp lại không lỗi, không đổi gì. `alter table if exists` giữ phong cách các migration trước.
 * Đường lùi (`down`): `RESET` đúng ba tham số trên mỗi bảng — về mặc định toàn cụm; tham số khác của bảng không đụng.
 */
const TABLES = [
  { table: "outbox_event", vacuum: "0.02", analyze: "0.02", costLimit: 400 },
  { table: "rate_limit_counter", vacuum: "0.01", analyze: "0.05", costLimit: 400 },
  { table: "webhook_inbox", vacuum: "0.05", analyze: "0.05", costLimit: 400 },
] as const;
const PARAMS =
  "autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor, autovacuum_vacuum_cost_limit";

export class Migration20261031090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const t of TABLES) {
      this.addSql(
        `alter table if exists "${t.table}" set (autovacuum_vacuum_scale_factor = ${t.vacuum}, autovacuum_analyze_scale_factor = ${t.analyze}, autovacuum_vacuum_cost_limit = ${t.costLimit});`,
      );
    }
  }

  override async down(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    for (const t of TABLES) this.addSql(`alter table if exists "${t.table}" reset (${PARAMS});`);
  }
}
