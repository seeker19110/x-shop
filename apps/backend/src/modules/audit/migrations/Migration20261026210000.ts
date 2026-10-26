import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Audit đủ trường sự kiện bảo mật (T-091, SEC-LOG-002, CMP-AUDIT-002): thêm `outcome` (kết quả) và `user_agent` (nguồn).
 *
 * Chạy được trên dữ liệu có sẵn mà KHÔNG cần UPDATE (bảng có trigger append-only chặn UPDATE/DELETE):
 *  - hai cột thêm vào là NULL cho dòng cũ — dòng ghi trước T-091 không biết kết quả thật (vd `rbac.denied` là từ chối),
 *    điền mặc định `success` cho chúng sẽ là dữ liệu sai; NULL = "không ghi nhận (trước T-091)";
 *  - `outcome` chỉ nhận `success | failure | denied` (CHECK; NULL qua CHECK) — ứng dụng luôn ghi giá trị cho dòng mới;
 *  - `user_agent` tối đa 256 ký tự (CHECK) — ứng dụng cắt ngắn và che PII lẫn trong chuỗi trước khi ghi.
 * `ADD COLUMN` không giá trị mặc định chỉ đổi catalog (không viết lại bảng, không kích trigger hàng).
 *
 * Đường lùi: `down` bỏ ràng buộc, chỉ mục và hai cột (mất giá trị đã ghi của hai cột này — các cột cũ giữ nguyên).
 */
export class Migration20261026210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "audit_log" add column if not exists "outcome" text null;`);
    this.addSql(`alter table if exists "audit_log" add column if not exists "user_agent" text null;`);
    this.addSql(`alter table if exists "audit_log" drop constraint if exists "audit_log_outcome_check";`);
    this.addSql(`alter table if exists "audit_log" add constraint "audit_log_outcome_check"
      check ("outcome" in ('success', 'failure', 'denied'));`);
    this.addSql(`alter table if exists "audit_log" drop constraint if exists "audit_log_user_agent_length";`);
    this.addSql(`alter table if exists "audit_log" add constraint "audit_log_user_agent_length"
      check (char_length("user_agent") <= 256);`);
    this.addSql(
      `create index if not exists "IDX_audit_log_action_outcome" on "audit_log" ("action", "outcome", "created_at" desc);`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_audit_log_action_outcome";`);
    this.addSql(`alter table if exists "audit_log" drop constraint if exists "audit_log_user_agent_length";`);
    this.addSql(`alter table if exists "audit_log" drop constraint if exists "audit_log_outcome_check";`);
    this.addSql(`alter table if exists "audit_log" drop column if exists "user_agent";`);
    this.addSql(`alter table if exists "audit_log" drop column if exists "outcome";`);
  }
}
