import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-184 (Q-02; DB-SEC-002, DB-PERF-005) — vai trò ứng dụng `xshop_app` (chỉ DML, không owner, không CREATE) trên DB này
 * và timeout đặt ở MỨC VAI TRÒ (không đặt toàn cục trong postgresql.conf).
 *
 * Vai trò là đối tượng cấp CLUSTER, do hạ tầng tạo (dev: scripts/dev-services.sh → scripts/db-roles.sh; CI: bước "Vai trò
 * DB" của ci.yml; production: hạ tầng). Migration KHÔNG tạo vai trò (không giữ mật khẩu) — vai trò chưa có thì mỗi khối
 * `raise notice` rồi bỏ qua, không lỗi (DB dev cũ, DB tạm của script).
 *
 * up():
 *  (1) `ALTER ROLE xshop_app SET statement_timeout = '30s'` + `idle_in_transaction_session_timeout = '60s'` — khớp mặc định
 *      phía ứng dụng (DB_STATEMENT_TIMEOUT_MS = 30000, DB_TIMEOUTS.idleInTransactionTimeoutMs = 60000 trong
 *      src/lib/infra/timeouts.ts; test db-roles đối chiếu). Áp cho mọi phiên ĐĂNG NHẬP bằng vai trò này, kể cả công cụ
 *      ngoài ứng dụng (psql, job). Thiết lập vai trò dùng chung cho cả cluster nên nhiều DB (DB test mỗi suite, nhiều
 *      worktree) có thể chạy khối này CÙNG LÚC: ALTER ROLE đồng thời trên cùng vai trò lỗi `23505` (hai phiên cùng chèn
 *      dòng pg_db_role_setting) hoặc `XX000 tuple concurrently updated` (đã đo trên Postgres 16.15). Lỗi chỉ nổ SAU khi
 *      phiên kia kết thúc → bắt hai mã đó trong khối con, đọc lại; đã đúng giá trị thì thôi (≤ 5 lần, quá thì ném lỗi).
 *      Vai trò migration cần quyền ALTER ROLE trên xshop_app (superuser, hoặc CREATEROLE + ADMIN OPTION trên xshop_app —
 *      scripts/db-roles.sql cấp cho xshop_migrator); thiếu quyền → lỗi 42501 (không nuốt).
 *  (2) Quyền trên schema `public` của DB NÀY: USAGE (không CREATE); SELECT/INSERT/UPDATE/DELETE mọi bảng hiện có; USAGE,
 *      SELECT mọi sequence (nextval); `ALTER DEFAULT PRIVILEGES` cùng các quyền đó cho bảng/sequence DO VAI TRÒ ĐANG CHẠY
 *      MIGRATION tạo sau này (bảng link của `db:migrate` tạo sau migration module, migration tương lai). Không TRUNCATE,
 *      REFERENCES, TRIGGER, không owner. Migration chạy bằng vai trò khác vai trò đã tạo bảng → GRANT ON ALL TABLES chỉ
 *      áp được bảng vai trò đó sở hữu/có quyền cấp (Postgres báo WARNING, không lỗi).
 *
 * down() (đường lùi): thu hồi đúng các quyền/default privileges ở (2) trên DB này và `RESET` hai thiết lập ở (1). RESET là
 * thao tác cấp cluster (mọi DB dùng vai trò này mất timeout cấp vai trò; timeout phía ứng dụng qua URL/driver vẫn còn).
 *
 * Không dùng EXECUTE/format() (check-migrations `dynamic-sql`): tên vai trò viết thẳng trong SQL.
 */
const ROLE_SETTINGS = `do $$
declare
  app_oid oid;
begin
  select oid into app_oid from pg_catalog.pg_roles where rolname = 'xshop_app';
  if app_oid is null then
    raise notice 'T-184: chưa có vai trò xshop_app — bỏ qua ALTER ROLE (tạo vai trò: scripts/db-roles.sh)';
    return;
  end if;
  for attempt in 1..5 loop
    exit when exists (
      select 1 from pg_catalog.pg_db_role_setting s
      where s.setdatabase = 0 and s.setrole = app_oid
        and s.setconfig @> array['statement_timeout=30s', 'idle_in_transaction_session_timeout=60s']
    );
    begin
      alter role xshop_app set statement_timeout = '30s';
      alter role xshop_app set idle_in_transaction_session_timeout = '60s';
      exit;
    exception when unique_violation or internal_error then
      if attempt = 5 then
        raise;
      end if;
    end;
  end loop;
end $$;`;

const GRANTS = `do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') then
    raise notice 'T-184: chưa có vai trò xshop_app — bỏ qua GRANT (tạo vai trò: scripts/db-roles.sh)';
    return;
  end if;
  grant usage on schema public to xshop_app;
  revoke create on schema public from xshop_app;
  grant select, insert, update, delete on all tables in schema public to xshop_app;
  grant usage, select on all sequences in schema public to xshop_app;
  alter default privileges in schema public grant select, insert, update, delete on tables to xshop_app;
  alter default privileges in schema public grant usage, select on sequences to xshop_app;
end $$;`;

const DOWN = `do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') then
    return;
  end if;
  alter default privileges in schema public revoke usage, select on sequences from xshop_app;
  alter default privileges in schema public revoke select, insert, update, delete on tables from xshop_app;
  revoke usage, select on all sequences in schema public from xshop_app;
  revoke select, insert, update, delete on all tables in schema public from xshop_app;
  revoke usage on schema public from xshop_app;
  alter role xshop_app reset statement_timeout;
  alter role xshop_app reset idle_in_transaction_session_timeout;
end $$;`;

export class Migration20261029120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(ROLE_SETTINGS);
    this.addSql(GRANTS);
  }

  override async down(): Promise<void> {
    this.addSql(DOWN);
  }
}
