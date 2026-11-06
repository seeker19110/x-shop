import { createRequire } from "node:module";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { MigrationScriptsMigrator } from "@medusajs/framework/migrations";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { isNonEmpty } from "@x-shop/domain";
import appRoleBookkeepingReadonly from "../../src/migration-scripts/app-role-bookkeeping-readonly";
import { MIGRATION_BOOKKEEPING_TABLES } from "../../src/lib/db/app-role";
import { parseEnv } from "../../src/lib/env";
import { DB_TIMEOUTS } from "../../src/lib/infra/timeouts";
import { Migration20261029120000 } from "../../src/modules/checkout/migrations/Migration20261029120000";

jest.setTimeout(180 * 1000);

/**
 * T-184 (Q-02) — vai trò DB tách quyền trên DB test THẬT (DB riêng của suite, đã chạy mọi migration):
 *  - DB-SEC-002: `xshop_app` chỉ DML (không superuser/owner/CREATE), bảng sổ migration chỉ SELECT; `xshop_migrator` không
 *    superuser/CREATEROLE, chỉ có membership SET trên xshop_app (không ADMIN/INHERIT); cả ca ĐƯỢC PHÉP lẫn BỊ TỪ CHỐI (42501)
 *    chạy thật bằng ĐĂNG NHẬP vai trò đó.
 *  - DB-PERF-005: statement_timeout + idle_in_transaction_session_timeout đặt ở mức vai trò bởi migration (lưới an toàn,
 *    xshop_app tự đổi được — không phải kiểm soát bảo mật), khớp mặc định phía ứng dụng; migration lũy đẳng, chạy đồng thời
 *    không lỗi (cả nhánh chèn lẫn nhánh cập nhật dòng pg_db_role_setting), vai trò vắng không lỗi, down() hoàn lại.
 *  - DB-SEC-007 (Q-02 phương án A — không áp dụng): một đơn vị bán, không đa tenant → 0 bảng có cột `tenant_id`.
 * Vai trò cấp cluster do scripts/db-roles.sh tạo (dev-services.sh / bước CI) — test KHÔNG tự tạo, để bắt được môi trường
 * thiếu vai trò. Mật khẩu: XS_PG_APP_PASSWORD / XS_PG_MIGRATOR_PASSWORD, vắng = giá trị giả mặc định của db-roles.sh.
 * Thiết lập cấp vai trò là của CẢ CLUSTER: test chỉ đụng đúng hai tham số timeout và trả giá trị ban đầu ở afterAll.
 */

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
const { Client } = createRequire(require.resolve("@medusajs/framework"))("pg") as {
  Client: new (opts: { connectionString: string }) => PgClient;
};

const APP = "xshop_app";
const MIGRATOR = "xshop_migrator";
// Biến đặt rỗng ("") = không đặt → mật khẩu dev mặc định.
const envOr = (value: string | undefined, fallback: string) => (isNonEmpty(value) ? value : fallback);
const APP_PASSWORD = envOr(process.env.XS_PG_APP_PASSWORD, "xshop-app-dev-SENTINEL");
const MIGRATOR_PASSWORD = envOr(process.env.XS_PG_MIGRATOR_PASSWORD, "xshop-migrator-dev-SENTINEL");
const TIMEOUT_PARAMS = ["statement_timeout", "idle_in_transaction_session_timeout"] as const;
const BOOKKEEPING = new Set<string>(MIGRATION_BOOKKEEPING_TABLES);
const ROLE_SETTINGS = ["statement_timeout=30s", "idle_in_transaction_session_timeout=60s"];
const DENIED = "42501";

/** SQL thật của migration (up/down) — không chép tay. */
async function migrationSql(kind: "up" | "down"): Promise<string[]> {
  const out: string[] = [];
  const capture = { addSql: (sql: string) => out.push(sql) } as unknown as Migration20261029120000;
  await Migration20261029120000.prototype[kind].call(capture);
  return out;
}

/** URL tới DB test của suite bằng vai trò/mật khẩu cho trước (mặc định: tài khoản quản trị của DATABASE_URL). */
function urlFor(database: string, user?: { name: string; password: string }): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.pathname = `/${database}`;
  if (user) {
    u.username = encodeURIComponent(user.name);
    u.password = encodeURIComponent(user.password);
  }
  return u.toString();
}

async function withClient<T>(url: string, run: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}

async function sqlState(run: () => PromiseLike<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return String((e as { code?: unknown }).code);
  }
  return "OK";
}

/** Đặt (giá trị) hoặc RESET (null) đúng một tham số timeout của xshop_app — không `reset all` cấp cluster. */
async function setAppTimeout(
  run: (sql: string) => PromiseLike<unknown>,
  param: (typeof TIMEOUT_PARAMS)[number],
  value: string | null,
): Promise<void> {
  if (value === null) {
    await run(`alter role xshop_app reset ${param}`);
    return;
  }
  if (!/^[0-9a-z]+$/.test(value)) throw new Error(`giá trị timeout lạ: ${value}`);
  await run(`alter role xshop_app set ${param} = '${value}'`);
}

async function roleSettings(pg: Knex): Promise<string[]> {
  const { rows } = await pg.raw(
    `select coalesce(s.setconfig, '{}') as setconfig
       from pg_roles r left join pg_db_role_setting s on s.setrole = r.oid and s.setdatabase = 0
      where r.rolname = ?`,
    [APP],
  );
  return rows[0]?.setconfig ?? [];
}

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    let pg: Knex;
    let database: string;
    const original = new Map<(typeof TIMEOUT_PARAMS)[number], string | null>();

    beforeAll(async () => {
      pg = getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);
      database = (await pg.raw("select current_database() as db")).rows[0].db;
      const { rows } = await pg.raw("select rolname from pg_roles where rolname in (?, ?)", [APP, MIGRATOR]);
      if (rows.length !== 2) {
        throw new Error(
          `Thiếu vai trò ${APP}/${MIGRATOR} trên Postgres — chạy bash scripts/dev-services.sh (hoặc scripts/db-roles.sh)`,
        );
      }
      const current = await roleSettings(pg);
      for (const param of TIMEOUT_PARAMS) {
        const entry = current.find((e) => e.startsWith(`${param}=`));
        original.set(param, entry === undefined ? null : entry.slice(param.length + 1));
      }
    });

    // Kết nối riêng tới DB quản trị: afterAll của runner đã đóng kết nối/DB của suite. Thiết lập vai trò là cấp cluster.
    afterAll(async () => {
      await withClient(process.env.DATABASE_URL as string, async (c) => {
        for (const [param, value] of original) await setAppTimeout((sql) => c.query(sql), param, value);
      });
    });

    describe("DB-SEC-002 — thuộc tính vai trò (cấp cluster)", () => {
      it("xshop_app: đăng nhập được, không superuser/tạo DB/tạo vai trò/replication/bypass RLS, không thuộc vai trò nào", async () => {
        const { rows } = await pg.raw(
          `select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
             from pg_roles where rolname = ?`,
          [APP],
        );
        expect(rows).toEqual([
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
            rolcanlogin: true,
          },
        ]);
        const member = await pg.raw(
          "select roleid::regrole::text as role from pg_auth_members where member = ?::regrole",
          [APP],
        );
        expect(member.rows).toEqual([]);
      });

      it("xshop_migrator: không superuser/tạo DB/tạo vai trò/bypass RLS; membership SET trên xshop_app, không ADMIN/INHERIT", async () => {
        const { rows } = await pg.raw(
          `select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
             from pg_roles where rolname = ?`,
          [MIGRATOR],
        );
        expect(rows).toEqual([
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
            rolcanlogin: true,
          },
        ]);
        const member = await pg.raw(
          `select roleid::regrole::text as role, admin_option, inherit_option, set_option
             from pg_auth_members where member = ?::regrole`,
          [MIGRATOR],
        );
        expect(member.rows.length).toBeGreaterThan(0);
        for (const m of member.rows) {
          expect(m).toEqual({ role: APP, admin_option: false, inherit_option: false, set_option: true });
        }
        const has = await pg.raw(
          `select pg_has_role(?, ?, 'USAGE') as usage, pg_has_role(?, ?, 'SET') as set_role,
                  has_table_privilege(?, 'public."order"', 'SELECT') as sel`,
          [MIGRATOR, APP, MIGRATOR, APP, MIGRATOR],
        );
        expect(has.rows[0]).toEqual({ usage: false, set_role: true, sel: false });
      });
    });

    describe("DB-SEC-002 — quyền của xshop_app trên DB đã migrate (migration Migration20261029120000)", () => {
      it("mọi bảng public (trừ bảng sổ migration): đủ SELECT/INSERT/UPDATE/DELETE, không TRUNCATE/REFERENCES/TRIGGER, không owner", async () => {
        const { rows } = await pg.raw(
          `select c.oid::regclass::text as name, pg_get_userbyid(c.relowner) as owner,
                  has_table_privilege(?, c.oid, 'SELECT') as sel, has_table_privilege(?, c.oid, 'INSERT') as ins,
                  has_table_privilege(?, c.oid, 'UPDATE') as upd, has_table_privilege(?, c.oid, 'DELETE') as del,
                  has_table_privilege(?, c.oid, 'TRUNCATE') as trunc, has_table_privilege(?, c.oid, 'REFERENCES') as refs,
                  has_table_privilege(?, c.oid, 'TRIGGER') as trig
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p')
            order by 1`,
          Array(7).fill(APP),
        );
        // Bảng lõi Medusa (trước migration), bảng module dự án (sau) và bảng link do db:migrate tạo sau cùng.
        expect(rows.length).toBeGreaterThan(50);
        expect(rows.map((r: { name: string }) => r.name)).toEqual(
          expect.arrayContaining(['"order"', "user_role", "checkout_attempt", "audit_log"]),
        );
        const wrong = rows.filter(
          (r: Record<string, unknown>) =>
            !BOOKKEEPING.has(String(r.name)) &&
            // has_table_privilege trả boolean (null nếu bảng biến mất giữa chừng — tính như không có quyền).
            (!(r.sel === true && r.ins === true && r.upd === true && r.del === true) ||
              r.trunc === true ||
              r.refs === true ||
              r.trig === true ||
              r.owner === APP),
        );
        expect(wrong).toEqual([]);
      });

      it("bảng sổ migration: migration chặn ghi mikro_orm_migrations; cuối db:migrate (migration script) chặn cả 3 — ĐĂNG NHẬP xshop_app chỉ SELECT", async () => {
        const writable = async (table: string) =>
          (
            await pg.raw(
              `select has_table_privilege(?, ?, 'INSERT') or has_table_privilege(?, ?, 'UPDATE')
                   or has_table_privilege(?, ?, 'DELETE') or has_table_privilege(?, ?, 'TRUNCATE') as w`,
              [APP, table, APP, table, APP, table, APP, table],
            )
          ).rows[0].w;
        // Migration module chạy khi mikro_orm_migrations đã có → chặn ngay.
        expect(await writable("mikro_orm_migrations")).toBe(false);
        // Giống cuối `medusa db:migrate`: runner tạo script_migrations rồi chạy migration script của dự án.
        await new MigrationScriptsMigrator({ container: getContainer() }).ensureMigrationsTable();
        await appRoleBookkeepingReadonly({ container: getContainer() } as never);
        const codes: Record<string, string> = {};
        await withClient(urlFor(database, { name: APP, password: APP_PASSWORD }), async (c) => {
          for (const table of MIGRATION_BOOKKEEPING_TABLES) {
            expect(await sqlState(() => c.query(`select count(*) from ${table}`))).toBe("OK");
            for (const sql of [
              `insert into ${table} default values`,
              `update ${table} set id = id where false`,
              `delete from ${table} where false`,
              `truncate ${table}`,
            ]) {
              codes[sql] = await sqlState(() => c.query(sql));
            }
          }
        });
        expect(Object.entries(codes).filter(([, code]) => code !== DENIED)).toEqual([]);
        expect(Object.keys(codes)).toHaveLength(12);
      });

      it("sequence: USAGE/SELECT (nextval), không UPDATE (setval); schema/DB: không CREATE, không owner gì", async () => {
        const seq = await pg.raw(
          `select c.oid::regclass::text as name, has_sequence_privilege(?, c.oid, 'USAGE') as usage,
                  has_sequence_privilege(?, c.oid, 'SELECT') as sel, has_sequence_privilege(?, c.oid, 'UPDATE') as upd
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'S'`,
          [APP, APP, APP],
        );
        expect(
          seq.rows.filter(
            (r: Record<string, unknown>) => r.usage !== true || r.sel !== true || r.upd === true,
          ),
        ).toEqual([]);
        const misc = await pg.raw(
          `select has_schema_privilege(?, 'public', 'CREATE') as schema_create,
                  has_schema_privilege(?, 'public', 'USAGE') as schema_usage,
                  has_database_privilege(?, current_database(), 'CREATE') as db_create,
                  (select pg_get_userbyid(datdba) from pg_database where datname = current_database()) as db_owner,
                  (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public') as schema_owner,
                  (select count(*)::int from pg_class where relowner = ?::regrole) as owned_relations`,
          [APP, APP, APP, APP],
        );
        expect(misc.rows[0]).toMatchObject({
          schema_create: false,
          schema_usage: true,
          db_create: false,
          owned_relations: 0,
        });
        expect(misc.rows[0].db_owner).not.toBe(APP);
        expect(misc.rows[0].schema_owner).not.toBe(APP);
      });

      it("chạy bằng xshop_app (SET ROLE): DML được; DDL/TRUNCATE/setval/đổi thuộc tính vai trò bị từ chối 42501", async () => {
        const trx = await pg.transaction();
        try {
          // Bảng/sequence tạo SAU migration bởi vai trò chạy migration → default privileges phải cấp DML cho xshop_app.
          await trx.raw("create table t184_probe (id int primary key, note text)");
          await trx.raw("create sequence t184_probe_seq");
          await trx.raw("set local role xshop_app");
          await trx.raw("insert into t184_probe values (1, 'a')");
          await trx.raw("update t184_probe set note = 'b' where id = 1");
          expect((await trx.raw("select note from t184_probe")).rows).toEqual([{ note: "b" }]);
          await trx.raw("delete from t184_probe where id = 1");
          expect((await trx.raw("select nextval('t184_probe_seq')::int as n")).rows).toEqual([{ n: 1 }]);
          // Bảng lõi Medusa có từ trước migration.
          await trx.raw(`select count(*) from "order"`);
          const denied: Record<string, string> = {};
          for (const sql of [
            "create table t184_denied (id int)",
            "create schema t184_denied",
            "alter table t184_probe add column extra int",
            "create index t184_probe_note on t184_probe (note)",
            "drop table t184_probe",
            "truncate t184_probe",
            "select setval('t184_probe_seq', 100)",
            `alter table "order" disable trigger all`,
            "alter role xshop_app createdb",
          ]) {
            await trx.raw("savepoint s");
            denied[sql] = await sqlState(() => trx.raw(sql));
            await trx.raw("rollback to savepoint s");
          }
          expect(Object.entries(denied).filter(([, code]) => code !== DENIED)).toEqual([]);
        } finally {
          await trx.rollback();
        }
      });

      it("ĐĂNG NHẬP xshop_migrator: chạy được khối timeout của migration (qua SET ROLE xshop_app); tạo vai trò/đổi mật khẩu/NOLOGIN/tự cấp INHERIT/xoá xshop_app bị từ chối 42501", async () => {
        const [roleBlock] = await migrationSql("up");
        if (roleBlock === undefined) throw new Error("migration up() phải có khối ALTER ROLE");
        await withClient(urlFor(database, { name: MIGRATOR, password: MIGRATOR_PASSWORD }), async (c) => {
          await c.query("begin");
          try {
            // Lệch giá trị (trong transaction, rollback ở cuối) để khối PHẢI chạy ALTER ROLE chứ không thoát sớm.
            await c.query(
              "select set_config('role', 'xshop_app', true); alter role xshop_app set statement_timeout = '1s'; reset role",
            );
            await c.query(roleBlock);
            const { rows } = await c.query(
              `select current_user as who, (select setconfig from pg_db_role_setting
                  where setdatabase = 0 and setrole = 'xshop_app'::regrole) as setconfig`,
            );
            expect(rows[0]?.who).toBe(MIGRATOR);
            expect(rows[0]?.setconfig).toEqual(expect.arrayContaining(ROLE_SETTINGS));
            const denied: Record<string, string> = {};
            for (const sql of [
              "create role t184_backdoor login",
              "alter role xshop_app password 'x-SENTINEL'",
              "alter role xshop_app nologin",
              "alter role xshop_app superuser",
              "alter role xshop_app createdb",
              "alter role xshop_migrator createrole",
              "grant xshop_app to xshop_migrator with inherit true",
              "grant xshop_app to xshop_migrator with admin true",
              "drop role xshop_app",
            ]) {
              await c.query("savepoint s");
              denied[sql] = await sqlState(() => c.query(sql));
              await c.query("rollback to savepoint s");
            }
            expect(Object.entries(denied).filter(([, code]) => code !== DENIED)).toEqual([]);
          } finally {
            await c.query("rollback");
          }
        });
      });
    });

    describe("DB-PERF-005 — timeout ở mức vai trò (migration)", () => {
      it("pg_db_role_setting của xshop_app có hai timeout; khớp mặc định phía ứng dụng", async () => {
        expect(await roleSettings(pg)).toEqual(expect.arrayContaining(ROLE_SETTINGS));
        const env = parseEnv({ DATABASE_URL: process.env.DATABASE_URL });
        if (!env.ok) throw new Error("env mặc định phải hợp lệ");
        // '30s' / '60s' của migration = DB_STATEMENT_TIMEOUT_MS mặc định / DB_TIMEOUTS.idleInTransactionTimeoutMs.
        expect(env.env.DB_STATEMENT_TIMEOUT_MS).toBe(30_000);
        expect(DB_TIMEOUTS.idleInTransactionTimeoutMs).toBe(60_000);
      });

      it("ĐĂNG NHẬP bằng xshop_app (mật khẩu): phiên nhận hai timeout ≠ 0; DML được, CREATE TABLE bị từ chối", async () => {
        await withClient(urlFor(database, { name: APP, password: APP_PASSWORD }), async (c) => {
          const { rows } = await c.query(
            `select current_user as who,
                    (select setting from pg_settings where name = 'statement_timeout') as stmt_ms,
                    (select setting from pg_settings where name = 'idle_in_transaction_session_timeout') as idle_ms`,
          );
          expect(rows[0]).toEqual({ who: APP, stmt_ms: "30000", idle_ms: "60000" });
          await c.query(`select count(*) from "order"`);
          expect(await sqlState(() => c.query("create table t184_login_denied (id int)"))).toBe(DENIED);
        });
      });

      it("migration lũy đẳng: chạy lại up() hai lần không lỗi, thiết lập giữ nguyên", async () => {
        for (let i = 0; i < 2; i++) {
          for (const sql of await migrationSql("up")) await pg.raw(sql);
        }
        expect(await roleSettings(pg)).toEqual(expect.arrayContaining(ROLE_SETTINGS));
      });

      it.each([
        ["vắng (RESET đúng 2 tham số) → nhánh chèn, 23505", null],
        ["giá trị khác ('1s') → nhánh cập nhật, XX000", "1s"],
      ])(
        "ĐỒNG THỜI: 8 phiên cùng chạy khối ALTER ROLE của up() khi thiết lập %s → tất cả thành công, thiết lập đúng",
        async (_label, start) => {
          const [roleBlock] = await migrationSql("up");
          if (roleBlock === undefined) throw new Error("migration up() phải có khối ALTER ROLE");
          try {
            for (let round = 0; round < 3; round++) {
              for (const param of TIMEOUT_PARAMS) await setAppTimeout((sql) => pg.raw(sql), param, start);
              const results = await Promise.allSettled(
                Array.from({ length: 8 }, () =>
                  withClient(urlFor(database), (c) => c.query(`begin; ${roleBlock} commit;`)),
                ),
              );
              expect(results.filter((r) => r.status === "rejected")).toEqual([]);
              expect(await roleSettings(pg)).toEqual(expect.arrayContaining(ROLE_SETTINGS));
            }
          } finally {
            // Thiết lập là cấp cluster — luôn đưa về giá trị của migration dù ca đỏ (afterAll trả giá trị ban đầu).
            await pg.raw(roleBlock);
          }
        },
      );

      it("vai trò không tồn tại: up() và down() không lỗi, không tạo thiết lập nào", async () => {
        const ghost = "xshop_t184_khong_ton_tai";
        const swap = (sql: string) => sql.replaceAll(APP, ghost);
        for (const sql of [...(await migrationSql("up")), ...(await migrationSql("down"))]) {
          await pg.raw(swap(sql));
        }
        const { rows } = await pg.raw("select count(*)::int as n from pg_roles where rolname = ?", [ghost]);
        expect(rows).toEqual([{ n: 0 }]);
      });

      it("down() hoàn lại: RESET timeout + thu hồi DML/default privileges (trong transaction rồi rollback)", async () => {
        const trx = await pg.transaction();
        try {
          for (const sql of await migrationSql("down")) await trx.raw(sql);
          const { rows } = await trx.raw(
            `select coalesce((select setconfig from pg_db_role_setting
                               where setdatabase = 0 and setrole = ?::regrole), '{}') as setconfig,
                    has_table_privilege(?, 'public."order"', 'SELECT') as sel`,
            [APP, APP],
          );
          expect(rows[0]).toEqual({ setconfig: [], sel: false });
          await trx.raw("create table t184_after_down (id int)");
          const after = await trx.raw("select has_table_privilege(?, 't184_after_down', 'SELECT') as sel", [
            APP,
          ]);
          expect(after.rows[0]).toEqual({ sel: false });
        } finally {
          await trx.rollback();
        }
        expect(await roleSettings(pg)).toEqual(expect.arrayContaining(ROLE_SETTINGS));
        const back = await pg.raw(`select has_table_privilege(?, 'public."order"', 'SELECT') as sel`, [APP]);
        expect(back.rows[0]).toEqual({ sel: true });
      });
    });

    describe("DB-SEC-007 — không áp dụng (Q-02: một đơn vị bán, không đa tenant)", () => {
      it("catalog: 0 bảng có cột tenant_id (RLS theo tenant không có đối tượng áp)", async () => {
        const { rows } = await pg.raw(
          `select table_schema || '.' || table_name as name from information_schema.columns
            where column_name = 'tenant_id' and table_schema not in ('pg_catalog', 'information_schema')`,
        );
        expect(rows).toEqual([]);
      });
    });
  },
});
