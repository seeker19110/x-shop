-- Quyền của xshop_app trên MỘT DB (T-184, Q-02; DB-SEC-002, DB-PERF-005; D-138). Lũy đẳng, không chứa mật khẩu.
-- Hai khối DO đầu là bản NGUYÊN VĂN của migration Migration20261029120000 (module checkout) — test đơn vị
-- apps/backend/src/lib/db/__tests__/app-role.unit.spec.ts đỏ khi lệch. Dùng khi:
--   - dev/CI: scripts/db-roles.sh chạy ngay sau db-roles.sql (DB dev đã migrate TRƯỚC khi có vai trò);
--   - production/bất kỳ DB nào: vai trò được tạo SAU lần `db:migrate` đầu, hoặc đã chạy `db:migrate --skip-links` /
--     `--skip-scripts` rồi sync link sau (bảng sổ link_module_migrations/script_migrations nhận DML qua default privileges):
--       psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-app-grants.sql
--     (chạy bằng vai trò migration — owner các bảng; cần membership SET trên xshop_app hoặc superuser).
-- Biến psql tuỳ chọn `legacy_owner` (dev/CI: xshop — vai trò superuser đang tạo bảng): thêm default privileges cho bảng do
-- legacy_owner VÀ xshop_migrator tạo sau này (cần superuser).

do $$
declare
  app_oid oid;
  prev_role text := current_user;
begin
  select oid into app_oid from pg_catalog.pg_roles where rolname = 'xshop_app';
  if app_oid is null then
    raise warning 'T-184: chưa có vai trò xshop_app — bỏ qua ALTER ROLE (tạo vai trò rồi chạy scripts/db-app-grants.sql)';
    return;
  end if;
  for attempt in 1..5 loop
    exit when exists (
      select 1 from pg_catalog.pg_db_role_setting s
      where s.setdatabase = 0 and s.setrole = app_oid
        and s.setconfig @> array['statement_timeout=30s', 'idle_in_transaction_session_timeout=60s']
    );
    begin
      perform pg_catalog.set_config('role', 'xshop_app', true);
      alter role xshop_app set statement_timeout = '30s';
      alter role xshop_app set idle_in_transaction_session_timeout = '60s';
      perform pg_catalog.set_config('role', prev_role, true);
      exit;
    exception when unique_violation or internal_error then
      if attempt = 5 then
        raise;
      end if;
    end;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') then
    raise warning 'T-184: chưa có vai trò xshop_app — bỏ qua GRANT (tạo vai trò rồi chạy scripts/db-app-grants.sql)';
    return;
  end if;
  grant usage on schema public to xshop_app;
  revoke create on schema public from xshop_app;
  grant select, insert, update, delete on all tables in schema public to xshop_app;
  grant usage, select on all sequences in schema public to xshop_app;
  alter default privileges in schema public grant select, insert, update, delete on tables to xshop_app;
  alter default privileges in schema public grant usage, select on sequences to xshop_app;
  if to_regclass('public.mikro_orm_migrations') is not null then
    revoke insert, update, delete on table public.mikro_orm_migrations from xshop_app;
  end if;
  if to_regclass('public.script_migrations') is not null then
    revoke insert, update, delete on table public.script_migrations from xshop_app;
  end if;
  if to_regclass('public.link_module_migrations') is not null then
    revoke insert, update, delete on table public.link_module_migrations from xshop_app;
  end if;
end $$;

\if :{?legacy_owner}
ALTER DEFAULT PRIVILEGES FOR ROLE :"legacy_owner", xshop_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO xshop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"legacy_owner", xshop_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO xshop_app;
\endif
