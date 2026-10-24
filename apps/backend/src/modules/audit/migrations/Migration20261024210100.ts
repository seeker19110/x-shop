import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Audit log CHỈ GHI THÊM (T-025, SPEC-admin S-405, ADM04): actor, thời điểm, hành động, đối tượng, lý do, thay đổi đã
 * che PII. Trigger chặn UPDATE/DELETE ở tầng DB — kể cả mã ứng dụng lỗi hay route tương lai cũng không sửa/xoá
 * được dòng đã ghi. Xoá theo hạn lưu trữ (nếu có) phải qua migration/thủ tục có kiểm soát, không qua ứng dụng.
 * TRUNCATE không chặn bằng trigger (công cụ test/khôi phục dùng nó); ứng dụng không bao giờ TRUNCATE.
 */
export class Migration20261024210100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "audit_log" (
      "id" text not null,
      "actor_type" text not null,
      "actor_id" text null,
      "action" text not null,
      "resource_type" text not null,
      "resource_id" text null,
      "reason" text null,
      "changes" jsonb not null default '{}'::jsonb,
      "request_id" text null,
      "ip_hash" text null,
      "created_at" timestamptz not null default clock_timestamp(),
      constraint "audit_log_pkey" primary key ("id")
    );`);
    this.addSql(
      `create index if not exists "IDX_audit_log_created" on "audit_log" ("created_at" desc, "id" desc);`,
    );
    this.addSql(
      `create index if not exists "IDX_audit_log_resource" on "audit_log" ("resource_type", "resource_id");`,
    );
    this.addSql(`create index if not exists "IDX_audit_log_actor" on "audit_log" ("actor_id");`);
    this.addSql(`create index if not exists "IDX_audit_log_action" on "audit_log" ("action");`);
    this.addSql(`create or replace function "x_append_only_guard"() returns trigger language plpgsql as $$
      begin
        raise exception 'bảng % chỉ cho ghi thêm (append-only)', TG_TABLE_NAME using errcode = '42501';
      end;
    $$;`);
    this.addSql(`drop trigger if exists "audit_log_no_update_delete" on "audit_log";`);
    this.addSql(`create trigger "audit_log_no_update_delete" before update or delete on "audit_log"
      for each row execute function "x_append_only_guard"();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "audit_log";`);
    this.addSql(`drop function if exists "x_append_only_guard"() cascade;`);
  }
}
