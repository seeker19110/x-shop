import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-170: `payment_attempt.vnp_create_date` (text, nullable) — ĐÚNG chuỗi `vnp_CreateDate` đã gửi trong URL thanh toán
 * (`yyyyMMddHHmmss` giờ VN, GMT+7). querydr/refund gửi lại làm `vnp_TransactionDate` (theo nguồn thứ cấp phải bằng
 * `vnp_CreateDate` của giao dịch gốc — chưa xác minh với tài liệu merchant, RK-006) thay cho `created_at` (mốc INSERT, lệch
 * vài trăm ms → thường khác giây). Lưu chuỗi, không lưu timestamptz: giá trị là dữ liệu protocol phải gửi lại nguyên văn.
 * CHECK `payment_attempt_vnp_create_date_format`: NULL hoặc đúng 14 chữ số.
 *
 * Expand thuần: cột nullable không DEFAULT → INSERT của bản N−1 (không biết cột) vẫn chạy, ghi NULL; dữ liệu cũ để NULL
 * (mã fallback `created_at` + log WARN; điền lại từ `payment_url` theo RUNBOOK §1.2 — không backfill trong migration).
 * PG ≥ 11 thêm cột nullable chỉ đổi catalog. Khoá: cả `up()` chạy trong MỘT transaction nên khoá ACCESS EXCLUSIVE của
 * `ADD COLUMN` giữ tới commit, gồm lúc `VALIDATE` quét bảng (mọi dòng NULL — chỉ đọc); bảng lớn nên chạy ngoài giờ cao
 * điểm và đặt `lock_timeout` ở phiên migrate.
 *
 * Tên lớp duy nhất trên mọi module (`src/modules/__tests__/migration-names.unit.spec.ts`).
 * Đường lùi: `down` bỏ CHECK và cột — mã quay về fallback `created_at` (log WARN mỗi lần querydr/refund).
 */
const CHECK = {
  name: "payment_attempt_vnp_create_date_format",
  expr: `vnp_create_date IS NULL OR vnp_create_date ~ '^[0-9]{14}$'`,
} as const;

export class Migration20261028083000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "payment_attempt" add column if not exists "vnp_create_date" text null;`,
    );
    this.addSql(`alter table if exists "payment_attempt" drop constraint if exists "${CHECK.name}";`);
    this.addSql(
      `alter table if exists "payment_attempt" add constraint "${CHECK.name}" check (${CHECK.expr}) not valid;`,
    );
    this.addSql(`alter table if exists "payment_attempt" validate constraint "${CHECK.name}";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "payment_attempt" drop constraint if exists "${CHECK.name}";`);
    this.addSql(`alter table if exists "payment_attempt" drop column if exists "vnp_create_date";`);
  }
}
