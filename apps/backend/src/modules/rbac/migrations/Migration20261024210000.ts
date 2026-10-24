import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Vai trò của admin user (T-023, SPEC-admin S-401). Không dùng RBAC native (Enterprise, `MEDUSA_FF_RBAC`). Một dòng /
 * (user, vai trò); khóa chính (user_id, role) = UNIQUE — cấp lại là no-op. Danh mục vai trò khóa bằng CHECK —
 * ghi cứng ở đây (migration là ảnh chụp bất biến); thêm vai trò mới = migration mới.
 */
export class Migration20261024210000 extends Migration {
  override async up(): Promise<void> {
    const roles = `'owner', 'catalog_manager', 'order_staff', 'warehouse', 'support', 'accountant'`;
    this.addSql(`create table if not exists "user_role" (
      "user_id" text not null,
      "role" text not null check ("role" in (${roles})),
      "granted_by" text null,
      "granted_at" timestamptz not null default now(),
      constraint "user_role_pkey" primary key ("user_id", "role")
    );`);
    this.addSql(`create index if not exists "IDX_user_role_role" on "user_role" ("role");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "user_role";`);
  }
}
