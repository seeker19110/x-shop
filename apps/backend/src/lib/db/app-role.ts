/**
 * Vai trò DB của ứng dụng (T-184, Q-02, DB-SEC-002, D-138) — hằng và SQL dùng chung cho migration script
 * `src/migration-scripts/app-role-bookkeeping-readonly.ts`. Migration Migration20261029120000 (module checkout) và
 * `scripts/db-app-grants.sql` chép nguyên văn cùng các câu REVOKE (migration không import được mã — check-migrations);
 * test đơn vị `app-role.unit.spec.ts` giữ ba nơi khớp nhau.
 */

/** Vai trò ứng dụng: chỉ DML, không owner/CREATE. */
export const APP_DB_ROLE = "xshop_app";

/**
 * Bảng SỔ MIGRATION của Medusa 2.22.1/MikroORM — xshop_app chỉ được SELECT. Ghi được = giả lịch sử migration, và với
 * `link_module_migrations`: `table_name` do ứng dụng chèn bị `db:sync-links` (vai trò migration) ghép vào DDL.
 */
export const MIGRATION_BOOKKEEPING_TABLES = [
  "mikro_orm_migrations",
  "script_migrations",
  "link_module_migrations",
] as const;

/** Câu thu hồi ghi trên MỘT bảng sổ (dạng nguyên văn trong migration và db-app-grants.sql). */
export function revokeBookkeepingStatement(table: (typeof MIGRATION_BOOKKEEPING_TABLES)[number]): string {
  return `revoke insert, update, delete on table public.${table} from xshop_app;`;
}

/**
 * Lũy đẳng; vai trò hoặc bảng vắng → bỏ qua. Chạy bằng vai trò migration (owner các bảng sổ). SQL tĩnh, không tham số
 * người dùng.
 */
export const REVOKE_BOOKKEEPING_WRITES_SQL = `do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') then
    return;
  end if;
  if to_regclass('public.mikro_orm_migrations') is not null then
    revoke insert, update, delete on table public.mikro_orm_migrations from xshop_app;
  end if;
  if to_regclass('public.script_migrations') is not null then
    revoke insert, update, delete on table public.script_migrations from xshop_app;
  end if;
  if to_regclass('public.link_module_migrations') is not null then
    revoke insert, update, delete on table public.link_module_migrations from xshop_app;
  end if;
end $$;`;

/** Vai trò ứng dụng có tồn tại trên cluster không. */
export const APP_ROLE_EXISTS_SQL = `select exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') as present`;
