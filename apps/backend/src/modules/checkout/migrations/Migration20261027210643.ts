import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-164: backoff kiểm lại theo đơn cho job `expire-holds` (nghẽn đầu hàng — review T-161 REPRO-B).
 *  - `order_finance.next_check_at` (timestamptz, nullable): đơn quá hạn có kết quả querydr chưa rõ/lỗi chỉ được xét lại
 *    từ mốc này; NULL = đến hạn ngay (dòng cũ không cần backfill).
 *  - `order_finance.hold_check_attempts` (integer NOT NULL DEFAULT 0, CHECK ≥ 0): số lần chưa rõ/lỗi liên tiếp — số mũ
 *    của backoff.
 * Expand thuần: hai cột thêm mới, nullable/có DEFAULT hằng → INSERT của bản N−1 (không biết cột) vẫn chạy; PG ≥ 11 thêm
 * cột có DEFAULT hằng chỉ đổi catalog (không viết lại bảng).
 * Khoá: MikroORM chạy cả `up()` trong MỘT transaction, nên khoá ACCESS EXCLUSIVE của `ADD COLUMN` giữ tới khi commit —
 * gồm cả lúc `VALIDATE` quét bảng; `NOT VALID` + `VALIDATE` ở đây KHÔNG rút ngắn khoá (chỉ giữ mẫu idempotent chung).
 * Chấp nhận được vì quét `order_finance` chỉ đọc một cột integer vừa thêm (mọi dòng = 0): chặn đọc/ghi đơn trong thời gian
 * quét — với bảng lớn nên chạy ngoài giờ cao điểm và đặt `lock_timeout` ở phiên migrate. Index `(state, hold_expires_at)`
 * sẵn có vẫn phục vụ truy vấn của job (lọc thêm trên tập nhỏ đơn quá hạn).
 *
 * Tên lớp duy nhất trên mọi module (`src/modules/__tests__/migration-names.unit.spec.ts`).
 * Đường lùi: `down` bỏ CHECK và hai cột — chỉ mất lịch backoff (trạng thái tạm): mọi đơn quá hạn lại được xét mỗi lượt
 * như trước T-164.
 */
const CHECK = {
  name: "order_finance_hold_check_attempts_nonneg",
  expr: `hold_check_attempts >= 0`,
} as const;

export class Migration20261027210643 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "order_finance" add column if not exists "next_check_at" timestamptz null, add column if not exists "hold_check_attempts" integer not null default 0;`,
    );
    this.addSql(`alter table if exists "order_finance" drop constraint if exists "${CHECK.name}";`);
    this.addSql(
      `alter table if exists "order_finance" add constraint "${CHECK.name}" check (${CHECK.expr}) not valid;`,
    );
    this.addSql(`alter table if exists "order_finance" validate constraint "${CHECK.name}";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "order_finance" drop constraint if exists "${CHECK.name}";`);
    this.addSql(
      `alter table if exists "order_finance" drop column if exists "next_check_at", drop column if exists "hold_check_attempts";`,
    );
  }
}
