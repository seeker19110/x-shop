import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-184 (Q-02; DB-SEC-002, DB-PERF-005; D-138) — vai trò ứng dụng `xshop_app` (chỉ DML, không owner, không CREATE) trên DB
 * này và timeout đặt ở MỨC VAI TRÒ (không đặt toàn cục trong postgresql.conf).
 *
 * Vai trò là đối tượng cấp CLUSTER, do hạ tầng tạo (dev: scripts/dev-services.sh → scripts/db-roles.sh; CI: bước "Vai trò
 * DB" của ci.yml; production: hạ tầng, TRƯỚC lần `db:migrate` đầu). Migration KHÔNG tạo vai trò (không giữ mật khẩu) — vai
 * trò chưa có thì mỗi khối `raise warning` rồi bỏ qua, không lỗi (DB dev cũ, DB tạm của script). Migration vẫn ghi là đã
 * chạy → tạo vai trò SAU thì áp lại bằng `scripts/db-app-grants.sql` (docs/ops/ENV.md mục "Vai trò DB").
 *
 * up():
 *  (1) `ALTER ROLE xshop_app SET statement_timeout = '30s'` + `idle_in_transaction_session_timeout = '60s'` — khớp mặc định
 *      phía ứng dụng (DB_STATEMENT_TIMEOUT_MS = 30000, DB_TIMEOUTS.idleInTransactionTimeoutMs = 60000 trong
 *      src/lib/infra/timeouts.ts; test db-roles đối chiếu). Đây là LƯỚI AN TOÀN (mặc định của mọi phiên đăng nhập bằng vai
 *      trò này, kể cả psql/job), KHÔNG phải kiểm soát bảo mật: xshop_app tự `SET`/`ALTER ROLE … SET` được thiết lập của nó.
 *      Câu ALTER chạy DƯỚI CHÍNH xshop_app (`set_config('role', 'xshop_app', true)` — Postgres 16 cho vai trò thường tự đặt
 *      mặc định của nó), rồi trả lại vai trò trước đó: vai trò migration KHÔNG cần CREATEROLE/ADMIN OPTION, chỉ cần
 *      membership `SET TRUE, INHERIT FALSE` trên xshop_app (scripts/db-roles.sql) hoặc là superuser. Thiếu → lỗi 42501.
 *      Thiết lập vai trò dùng chung cho cả cluster nên nhiều DB (DB test mỗi suite, nhiều worktree) có thể chạy khối này
 *      CÙNG LÚC: ALTER ROLE đồng thời trên cùng vai trò lỗi `23505` (hai phiên cùng chèn dòng pg_db_role_setting) hoặc
 *      `XX000 tuple concurrently updated` (đã đo trên Postgres 16.15). Lỗi chỉ nổ SAU khi phiên kia kết thúc → bắt hai mã
 *      đó trong khối con (khối con huỷ thì vai trò tạm cũng huỷ theo), đọc lại; đã đúng giá trị thì thôi (≤ 5 lần).
 *  (2) Quyền trên schema `public` của DB NÀY: USAGE (không CREATE); SELECT/INSERT/UPDATE/DELETE mọi bảng hiện có; USAGE,
 *      SELECT mọi sequence (nextval); `ALTER DEFAULT PRIVILEGES` cùng các quyền đó cho bảng/sequence DO VAI TRÒ ĐANG CHẠY
 *      MIGRATION tạo sau này (bảng link của `db:migrate`, migration tương lai). Không TRUNCATE/REFERENCES/TRIGGER/owner.
 *  (3) Bảng SỔ MIGRATION chỉ SELECT (review T-184): ghi được `mikro_orm_migrations`/`script_migrations` = giả lịch sử
 *      migration; ghi được `link_module_migrations` = chèn `table_name` tuỳ ý mà `db:sync-links` (chạy bằng vai trò migration)
 *      ghép vào DDL. Thu hồi INSERT/UPDATE/DELETE trên bảng nào đã có (TRUNCATE chưa từng cấp). Trên DB MỚI hai bảng sau được tạo SAU
 *      migration module (link sync, runner migration script) và nhận DML qua default privileges → migration script
 *      `src/migration-scripts/app-role-bookkeeping-readonly.ts` thu hồi lại ở cuối `medusa db:migrate`.
 *
 * down() (đường lùi): thu hồi đúng các quyền/default privileges ở (2) trên DB này và `RESET` hai thiết lập ở (1). RESET là
 * thao tác cấp cluster (mọi DB dùng vai trò này mất timeout cấp vai trò; timeout phía ứng dụng qua URL/driver vẫn còn).
 *
 * Không dùng EXECUTE/format() (check-migrations `dynamic-sql`): tên vai trò/bảng viết thẳng trong SQL.
 */
const ROLE_SETTINGS = `do $$
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
end $$;`;

const GRANTS = `do $$
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
end $$;`;

const DOWN = `do $$
declare
  prev_role text := current_user;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'xshop_app') then
    return;
  end if;
  alter default privileges in schema public revoke usage, select on sequences from xshop_app;
  alter default privileges in schema public revoke select, insert, update, delete on tables from xshop_app;
  revoke usage, select on all sequences in schema public from xshop_app;
  revoke select, insert, update, delete on all tables in schema public from xshop_app;
  revoke usage on schema public from xshop_app;
  perform pg_catalog.set_config('role', 'xshop_app', true);
  alter role xshop_app reset statement_timeout;
  alter role xshop_app reset idle_in_transaction_session_timeout;
  perform pg_catalog.set_config('role', prev_role, true);
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
