import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Audit đủ trường sự kiện bảo mật (T-091, SEC-LOG-002, CMP-AUDIT-002): thêm `outcome` (kết quả) và `user_agent` (nguồn).
 *
 * Tên lớp phải DUY NHẤT trên mọi module: Medusa ghi migration đã chạy theo TÊN — trùng tên với module khác (bản đầu
 * `Migration20261026210000` trùng module fashion) thì migration bị coi là đã chạy và bỏ qua âm thầm. Hàng rào:
 * `src/modules/__tests__/migration-names.unit.spec.ts`.
 *
 * Chạy được trên dữ liệu có sẵn mà KHÔNG cần UPDATE (bảng có trigger append-only chặn UPDATE/DELETE):
 *  - hai cột thêm vào là NULL cho dòng cũ — dòng ghi trước T-091 không biết kết quả thật (vd `rbac.denied` là từ chối),
 *    điền mặc định `success` cho chúng sẽ là dữ liệu sai; NULL = "không ghi nhận (trước T-091)";
 *  - `outcome` chỉ nhận `success | failure | denied` (CHECK; NULL qua CHECK) — ứng dụng luôn ghi giá trị cho dòng mới;
 *  - `user_agent` tối đa 256 ký tự (CHECK) — ứng dụng cắt ngắn và che PII lẫn trong chuỗi trước khi ghi.
 * `ADD COLUMN` không giá trị mặc định chỉ đổi catalog (không viết lại bảng, không kích trigger hàng). CHECK thêm bằng
 * `NOT VALID` (khoá ngắn, không quét bảng khi thêm) rồi `VALIDATE` (quét với khoá SHARE UPDATE EXCLUSIVE — ghi audit vẫn
 * chạy song song).
 *
 * Đường lùi: `down` bỏ ràng buộc, chỉ mục và hai cột (mất giá trị đã ghi của hai cột này — các cột cũ giữ nguyên).
 */
const CHECKS = [
  { name: "audit_log_outcome_check", expr: `"outcome" in ('success', 'failure', 'denied')` },
  { name: "audit_log_user_agent_length", expr: `char_length("user_agent") <= 256` },
] as const;

export class Migration20261027090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "audit_log" add column if not exists "outcome" text null;`);
    this.addSql(`alter table if exists "audit_log" add column if not exists "user_agent" text null;`);
    for (const c of CHECKS) {
      this.addSql(`alter table if exists "audit_log" drop constraint if exists "${c.name}";`);
      this.addSql(
        `alter table if exists "audit_log" add constraint "${c.name}" check (${c.expr}) not valid;`,
      );
      this.addSql(`alter table if exists "audit_log" validate constraint "${c.name}";`);
    }
    this.addSql(
      `create index if not exists "IDX_audit_log_action_outcome" on "audit_log" ("action", "outcome", "created_at" desc);`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_audit_log_action_outcome";`);
    for (const c of CHECKS) {
      this.addSql(`alter table if exists "audit_log" drop constraint if exists "${c.name}";`);
    }
    this.addSql(`alter table if exists "audit_log" drop column if exists "user_agent";`);
    this.addSql(`alter table if exists "audit_log" drop column if exists "outcome";`);
  }
}
