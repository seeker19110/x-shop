import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOW,
  applySchema,
  checkDrift,
  checkExpandContract,
  checkImmutable,
  checkStatic,
  contractFlag,
  customModules,
  destructiveOps,
  diffSnapshots,
  emptySchema,
  extractUpSql,
  main,
  normalizeSql,
  parseGenerateOutput,
} from "./check-migrations.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Schema N−1 dùng chung cho các ca: bảng "x" (id, col, amount, ràng buộc x_pkey) và index "IDX_x_amount". */
const BASE_SQL = [
  `create table if not exists "x" ("id" text not null, "col" text null, "amount" bigint null, constraint "x_pkey" primary key ("id"));`,
  `create index if not exists "IDX_x_amount" on "x" ("amount");`,
  `alter table "x" add constraint "x_amount_nonneg" check ("amount" >= 0);`,
];
const baseSchema = () => applySchema(BASE_SQL);

const rules = (sql, base = baseSchema()) => [...new Set(destructiveOps(sql, base).map((o) => o.rule))].sort();

/** Migration TS: `up`/`down` là mã thân phương thức (chuỗi), `head` chèn trước class (import, hằng, chú thích). */
const src = (up, { down = "", head = "", name = "Migration20990101000000" } = {}) =>
  `import { Migration } from "@medusajs/framework/mikro-orm/migrations";
${head}
export class ${name} extends Migration {
  override async up(): Promise<void> {
${up}
  }

  override async down(): Promise<void> {
${down}
  }
}
`;
/** Thân up() gồm các addSql(`…`). */
const adds = (...sql) => sql.map((s) => `    this.addSql(\`${s}\`);`).join("\n");

const KNOWN = new Set(["Migration20260101000000"]);
const check = (code, ctx = {}) =>
  checkExpandContract(code, {
    name: "Migration20990101000000",
    knownBase: KNOWN,
    baseSchema: baseSchema(),
    ...ctx,
  });
const ruleOf = (e) => /^([a-z-]+) trong up\(\)/.exec(e)?.[1];
const errRules = async (code, ctx) =>
  [...new Set((await check(code, ctx)).errors.map(ruleOf).filter(Boolean))].sort();

/* --------------------------------------------------------------- normalizeSql ---------------------------------- */

test("normalizeSql: bỏ chú thích SQL, chuỗi '…' (kể cả E'…\\'') thành '', định danh thành token, chữ thường", () => {
  const { text, idents } = normalizeSql(
    `ALTER TABLE "Order" -- drop table x\n /* truncate y */ ADD "a" text default 'drop table z';`,
  );
  assert.equal(text, "alter table ⟦0⟧ add ⟦1⟧ text default '';");
  assert.deepEqual(idents, ["order", "a"]);
  assert.equal(normalizeSql(`select 'it''s; drop table x'`).text, "select ''");
  assert.equal(normalizeSql(`select E'\\''; alter table x drop c`).text, "select e''; alter table x drop c");
});

/* --------------------------------------------------------------- trích SQL thật -------------------------------- */

test("extractUpSql: chạy up() với addSql giả — nối +, ${…}, map/join, hằng/hàm phụ; down() không chạy", async () => {
  const r = await extractUpSql(
    src(
      `    const cols = ["a", "b"].map((c) => \`drop column "\${c}"\`).join(", ");
    this.addSql("alter table \\"x\\" " + cols + ";");
    this.addSql(helper("y"));`,
      { head: 'const helper = (t: string) => `truncate "${t}";`;', down: adds(`drop table "z";`) },
    ),
  );
  assert.deepEqual(r, { sql: ['alter table "x" drop column "a", drop column "b";', 'truncate "y";'] });
});

test("extractUpSql: import lạ, knex, addSql không phải chuỗi, up() ném lỗi → error", async () => {
  const bad = [
    [
      src("    this.addSql(X);", { head: `import { X } from "../sql/legacy";` }),
      /import "\.\.\/sql\/legacy"/,
    ],
    [src(`    const k = this.getKnex();\n    this.addSql(k.schema.toString());`), /getKnex/],
    [src(`    this.addSql({ sql: "x" } as any);`), /addSql nhận object/],
    [src(`    throw new Error("boom");`), /up\(\) lỗi khi trích SQL: boom/],
    [`export const x = 1;`, /đúng một class/],
  ];
  for (const [code, re] of bad) assert.match((await extractUpSql(code)).error ?? "", re);
});

test("extractUpSql: dò môi trường (I2 typeof process, I8 globalThis.setTimeout, nuốt lỗi bằng try/catch) → error", async () => {
  const cases = [
    `    if (typeof process !== "undefined") this.addSql(\`alter table "x" drop column "col";\`);\n    else this.addSql(\`select 1;\`);`,
    `    const real = typeof (globalThis as any).setTimeout === "function";\n    this.addSql(real ? \`drop table "x";\` : \`select 1;\`);`,
    `    let real = false;\n    try { real = typeof Buffer === "function"; } catch { real = false; }\n    this.addSql(real ? \`drop table "x";\` : \`select 1;\`);`,
    `    if (process.env.PURGE === "1") this.addSql(\`alter table "x" drop column "col";\`);`,
  ];
  for (const up of cases)
    assert.match((await extractUpSql(src(up))).error ?? "", /đọc global môi trường/, up);
  // dò ở cấp module (ngoài up) cũng bị bắt
  const top = src(adds("select 1;"), { head: "const REAL = typeof console;" });
  assert.match((await extractUpSql(top)).error ?? "", /`console`/);
  assert.deepEqual(await errRules(src(cases[0])), ["unanalyzable"]);
});

test("extractUpSql: vòng lặp vô hạn (đồng bộ hay sau await) → error trong vài giây, không treo", async () => {
  for (const up of ["    while (true) {}", "    await Promise.resolve();\n    for (;;) {}"]) {
    const t0 = Date.now();
    assert.match((await extractUpSql(src(up), "m.ts", { timeoutMs: 500 })).error ?? "", /quá 500 ms/);
    assert.ok(Date.now() - t0 < 3000);
  }
  // hẹn giờ mặc định (3 s) — đúng ca I7 qua CLI không treo
  assert.match((await extractUpSql(src("    while (true) {}"))).error ?? "", /quá 3000 ms/);
  // up() chờ promise không bao giờ xong → worker hết việc, thoát không kết quả
  assert.match((await extractUpSql(src("    await new Promise(() => {});"))).error ?? "", /không xong/);
});

test("extractUpSql: export hai class migration (N3) → error", async () => {
  const two = `${src(adds("select 1;"))}\nexport class Migration20990101000001 extends Migration {\n  override async up(): Promise<void> {}\n}\n`;
  assert.match((await extractUpSql(two)).error ?? "", /đúng một class .* \(thấy 2\)/);
  assert.deepEqual(await errRules(two), ["unanalyzable"]);
});

test("extractUpSql: bind/alias addSql, await, class trung gian vẫn lấy đúng SQL (I1, I4, I5)", async () => {
  const r = await extractUpSql(`import { Migration } from "@medusajs/framework/mikro-orm/migrations";
const later = async () => \`truncate "y";\`;
abstract class Base extends Migration {
  protected drop(t: string, c: string) { this.addSql(\`alter table "\${t}" drop column "\${c}";\`); }
}
export class Migration20990101000000 extends Base {
  override async up(): Promise<void> {
    const a = this.addSql.bind(this);
    a(\`drop table "z";\`);
    this.addSql(await later());
    this.drop("x", "col");
  }
}`);
  assert.deepEqual(r, { sql: ['drop table "z";', 'truncate "y";', 'alter table "x" drop column "col";'] });
});

/* --------------------------------------------------------------- từng luật (SQL) ------------------------------- */

test("drop-table: bảng có trên base hoặc chưa tạo TRƯỚC đó trong file; miễn bảng mới tạo trước đó", () => {
  assert.deepEqual(rules([`drop table if exists "x";`]), ["drop-table"]);
  assert.deepEqual(rules([`DROP TABLE a, b CASCADE`]), ["drop-table"]);
  assert.deepEqual(rules([`create table "tmp" ("id" text);`, `drop table "tmp";`]), []);
  // thứ tự: drop rồi mới create → không miễn
  assert.deepEqual(rules([`drop table if exists "tmp";`, `create table "tmp" ("id" text);`]), ["drop-table"]);
  // create table if not exists trên bảng đã có ở base không làm bảng "mới"
  assert.deepEqual(rules([`create table if not exists "x" ("id" text);`, `drop table "x";`]), ["drop-table"]);
  assert.deepEqual(rules([`create table "tmp" ("id" text); drop table "tmp", "other";`]), ["drop-table"]);
});

test("drop-column: có/không từ khoá COLUMN, trong danh sách hành động; drop constraint lạ thì không", () => {
  assert.deepEqual(rules([`alter table if exists "q" drop column if exists "shipping";`]), ["drop-column"]);
  assert.deepEqual(rules([`alter table q drop shipping`]), ["drop-column"]);
  assert.deepEqual(rules([`alter table "r" add column "a" text null, drop column "b";`]), ["drop-column"]);
  assert.deepEqual(rules([`alter table if exists "q" drop constraint if exists "q_kind_check";`]), []);
});

test("rename-table (kể cả SET SCHEMA) / rename-column; rename constraint và ALTER INDEX … RENAME được phép", () => {
  assert.deepEqual(rules([`alter table "a" rename to "b";`]), ["rename-table"]);
  assert.deepEqual(rules([`alter table "x" set schema archive;`]), ["rename-table"]);
  assert.deepEqual(rules([`alter table "a" rename column "x" to "y";`]), ["rename-column"]);
  assert.deepEqual(rules([`ALTER TABLE ONLY public."a" RENAME x TO y`]), ["rename-column"]);
  assert.deepEqual(rules([`alter table "a" rename constraint "c1" to "c2";`]), []);
  assert.deepEqual(rules([`alter index "IDX_a" rename to "IDX_b";`]), []);
});

test("alter-column-type: TYPE / SET DATA TYPE; miễn chỉ cột thêm TRƯỚC, không có trên base, trên bảng đã biết", () => {
  assert.deepEqual(rules([`alter table "x" alter column "amount" type bigint;`]), ["alter-column-type"]);
  assert.deepEqual(rules([`alter table x alter amount set data type numeric using amount::numeric`]), [
    "alter-column-type",
  ]);
  assert.deepEqual(
    rules([
      `alter table "x" add column if not exists "n" int;`,
      `alter table "x" alter column "n" type bigint;`,
    ]),
    [],
  );
  // cột đã có trên base: add column if not exists không làm cột "mới"
  assert.deepEqual(
    rules([
      `alter table "x" add column if not exists "amount" int null;`,
      `alter table "x" alter column "amount" type bigint;`,
    ]),
    ["alter-column-type"],
  );
  // bảng không biết (vd bảng native Medusa): không miễn
  assert.deepEqual(
    rules([
      `alter table "order" add column if not exists "n" int;`,
      `alter table "order" alter column "n" type bigint;`,
    ]),
    ["alter-column-type"],
  );
  assert.deepEqual(
    rules([
      `alter table "x" alter column "col" set default 'a';`,
      `alter table "x" alter column "col" drop not null;`,
    ]),
    [],
  );
});

test("set-not-null: chặn kể cả cột vừa thêm không DEFAULT (INSERT của N−1 vỡ); miễn bảng mới hoặc cột thêm kèm DEFAULT", () => {
  assert.deepEqual(rules([`alter table "x" alter column "amount" set not null;`]), ["set-not-null"]);
  assert.deepEqual(
    rules([`alter table "x" add column "c" text null;`, `alter table "x" alter column "c" set not null;`]),
    ["set-not-null"],
  );
  assert.deepEqual(
    rules([
      `alter table "x" add column if not exists "c" text null;`,
      `update "x" set "c" = 'v' where "c" is null;`,
      `alter table "x" alter column "c" set not null;`,
    ]),
    ["set-not-null"],
  );
  assert.deepEqual(
    rules([
      `alter table "x" add column "c" text null default 'v';`,
      `alter table "x" alter column "c" set not null;`,
    ]),
    [],
  );
  assert.deepEqual(
    rules([`create table "t2" ("c" text null);`, `alter table "t2" alter column "c" set not null;`]),
    [],
  );
  // SET NOT NULL TRƯỚC khi thêm cột → không miễn
  assert.deepEqual(
    rules([
      `alter table "x" alter column "c" set not null;`,
      `alter table "x" add column "c" text default 'v';`,
    ]),
    ["set-not-null"],
  );
});

test("add-required-column: NOT NULL/PRIMARY KEY không DEFAULT trên bảng có sẵn; có DEFAULT/generated/serial hay bảng mới thì không", () => {
  assert.deepEqual(
    rules([`alter table if exists "x" add column if not exists "carrier_ref" text not null;`]),
    ["add-required-column"],
  );
  assert.deepEqual(rules([`alter table "order" add column "k" text primary key;`]), ["add-required-column"]);
  assert.deepEqual(rules([`alter table "x" add column "k" text not null default 'a';`]), []);
  assert.deepEqual(rules([`alter table "x" add column "k" bigserial not null;`]), []);
  assert.deepEqual(
    rules([`alter table "x" add column "k" int generated always as (1) stored not null;`]),
    [],
  );
  assert.deepEqual(
    rules([`create table "n" ("id" text);`, `alter table "n" add column "k" text not null;`]),
    [],
  );
  assert.deepEqual(rules([`alter table "x" add column "k" text null;`]), []);
});

test("truncate và delete không WHERE / WHERE true / 1=1 / WHERE chỉ trong truy vấn con bị bắt; delete có WHERE thì không", () => {
  assert.deepEqual(rules([`truncate table "x";`]), ["truncate"]);
  assert.deepEqual(rules([`create table "s" ("a" text);`, `truncate "s";`]), []);
  assert.deepEqual(rules([`delete from "x";`]), ["delete-without-where"]);
  assert.deepEqual(rules([`DELETE FROM "x" WHERE true;`]), ["delete-without-where"]);
  assert.deepEqual(rules([`delete from "x" where (1 = 1) returning *;`]), ["delete-without-where"]);
  assert.deepEqual(rules([`delete from "x" using (select 1 from "y" where 1=1) s;`]), [
    "delete-without-where",
  ]);
  assert.deepEqual(rules([`delete from "x" where "state" = 'x';`]), []);
  assert.deepEqual(rules([`delete from "x" using "y" where "x"."id" = "y"."id";`]), []);
  assert.deepEqual(rules([`do $$ begin delete from "t"; end $$;`]), ["delete-without-where"]);
  assert.deepEqual(rules([`do $$ begin delete from "t" where id = 1; end $$;`]), []);
  assert.deepEqual(
    rules([`create trigger g before update or delete on "a" for each row execute function f();`]),
    [],
  );
});

test("drop-index / drop-constraint: chỉ tên do migration trên base tạo và không tạo lại SAU đó", () => {
  assert.deepEqual(rules([`drop index if exists "IDX_x_amount";`]), ["drop-index"]);
  assert.deepEqual(rules([`alter table "x" drop constraint "x_pkey";`]), ["drop-constraint"]);
  assert.deepEqual(rules([`alter table "x" drop constraint if exists "x_amount_nonneg";`]), [
    "drop-constraint",
  ]);
  // mẫu idempotent: drop rồi tạo lại cùng tên
  assert.deepEqual(
    rules([
      `drop index if exists "IDX_x_amount";`,
      `create index if not exists "IDX_x_amount" on "x" ("amount", "id");`,
    ]),
    [],
  );
  assert.deepEqual(
    rules([
      `alter table "x" drop constraint if exists "x_amount_nonneg";`,
      `alter table "x" add constraint "x_amount_nonneg" check ("amount" >= 0) not valid;`,
    ]),
    [],
  );
  // tạo lại TRƯỚC khi drop không tính
  assert.deepEqual(
    rules([`create index if not exists "IDX_x_amount" on "x" ("amount");`, `drop index "IDX_x_amount";`]),
    ["drop-index"],
  );
  // tên không có trên base (drop phòng thủ của Medusa) → không báo
  assert.deepEqual(rules([`drop index if exists "IDX_x_col_unique";`]), []);
  assert.deepEqual(rules([`alter table if exists "x" drop constraint if exists "x_col_unique";`]), []);
});

test("drop-object: view/type/sequence/schema không tạo lại sau đó; drop trigger/function không bị chặn", () => {
  assert.deepEqual(
    rules([`drop view if exists "v_x"; drop function if exists f_x(); drop type if exists t_x;`]),
    ["drop-object"],
  );
  assert.deepEqual(rules([`drop view if exists "v"; create or replace view "v" as select 1;`]), []);
  assert.deepEqual(
    rules([`drop trigger if exists "g" on "x";`, `drop function if exists "f"() cascade;`]),
    [],
  );
});

test("dynamic-sql: PL/pgSQL EXECUTE và format('<DDL>') — không miễn bằng cờ contract", async () => {
  assert.deepEqual(rules([`do $$ begin execute 'alter table x drop column col'; end $$;`]), ["dynamic-sql"]);
  assert.deepEqual(rules([`do $$ begin execute format('drop table %I', 'x'); end $$;`]), ["dynamic-sql"]);
  assert.deepEqual(rules([`select format('hello %s', 'x');`]), []);
  const flagged = src(adds(`do $$ begin execute 'x'; end $$;`), {
    head: "// @migration-contract: bỏ cột cũ; expand ở Migration20260101000000",
  });
  assert.deepEqual(await errRules(flagged), ["dynamic-sql"]);
});

test("unanalyzable: ALTER TABLE không có hành động", () => {
  assert.deepEqual(rules([`alter table "x";`]), ["unanalyzable"]);
});

test("mẫu hợp lệ đang dùng: drop constraint/index if exists rồi tạo lại, add cột nullable, trigger — không báo", async () => {
  const code = src(
    adds(
      `alter table if exists "x" drop constraint if exists "x_amount_nonneg";`,
      `alter table if exists "x" add constraint "x_amount_nonneg" check("amount" >= 0);`,
      `drop index if exists "IDX_x_amount";`,
      `create unique index if not exists "IDX_x_amount" on "x" ("amount") where "amount" is not null;`,
      `alter table "x" add column if not exists "b" text null;`,
      `drop trigger if exists "g" on "x";`,
    ),
  );
  assert.deepEqual((await check(code)).errors, []);
});

/* --------------------------------------------------------------- ca tái hiện của review (file TS) -------------- */

const T = (s) => `    this.addSql(\`${s}\`);`;
const REVIEW_CASES = [
  ["A1 chữ hoa + xuống dòng", T(`ALTER TABLE "x" DROP\n      COLUMN "col";`), ["drop-column"]],
  ["A2 drop không COLUMN", T(`alter table x drop "col";`), ["drop-column"]],
  ["A3 chú thích giữa từ khoá", T(`ALTER   TABLE\t"x"\n DROP /* giữa */ COLUMN "col";`), ["drop-column"]],
  ["B1 rename to", T(`ALTER TABLE "x" RENAME TO "y";`), ["rename-table"]],
  [
    "B2 set data type",
    T(`ALTER TABLE "x" ALTER COLUMN "amount" SET DATA TYPE bigint;`),
    ["alter-column-type"],
  ],
  ["B3 type ngắn", T(`ALTER TABLE "x" ALTER "amount" TYPE bigint;`), ["alter-column-type"]],
  ["B4 rename không COLUMN", T(`ALTER TABLE "x" RENAME "col" TO "col2";`), ["rename-column"]],
  ["C1 nối +", `    this.addSql("alter table \\"x\\" " + "drop column \\"col\\";");`, ["drop-column"]],
  [
    "C2 nối + nhiều dòng",
    `    this.addSql(\n      'alter table "x" ' +\n      'drop column "col";',\n    );`,
    ["drop-column"],
  ],
  [
    "C3 hành động trong biến",
    '    this.addSql(`alter table "x" ${action};`);',
    ["drop-column"],
    'const action = `drop column "col"`;',
  ],
  [
    "C4 map/join",
    '    const drops = ["col"].map((c) => `drop column "${c}"`).join(", ");\n    this.addSql(`alter table "x" ${drops};`);',
    ["drop-column"],
  ],
  [
    "C5 import module khác",
    "    this.addSql(DROP_COL);",
    ["unanalyzable"],
    'import { DROP_COL } from "../sql/legacy";',
  ],
  ["C6 plpgsql execute", T(`do $$ begin execute 'alter table x drop column col'; end $$;`), ["dynamic-sql"]],
  ["C7 execute format", T(`do $$ begin execute format('drop table %I', 'x'); end $$;`), ["dynamic-sql"]],
  [
    "C8 định danh nội suy",
    '    this.addSql(`alter table "${T}" drop column "${C}";`);',
    ["drop-column"],
    'const T = "x"; const C = "col";',
  ],
  [
    "C9 knex builder",
    '    const knex = this.getKnex();\n    this.addSql(knex.schema.alterTable("x", (t) => t.dropColumn("col")).toQuery());',
    ["unanalyzable"],
  ],
  ["D2 up dạng arrow", null, ["drop-column"]],
  [
    "D3 hàm phụ tên down()",
    "    this.addSql(sql.down());",
    ["drop-column"],
    'const sql = {\n  down() {\n    return `alter table "x" drop column "col";`;\n  },\n};',
  ],
  ["F1 WHERE true", T(`DELETE FROM "x" WHERE true;`), ["delete-without-where"]],
  [
    "F2 WHERE chỉ trong truy vấn con",
    T(`delete from "x" using (select 1 from "y" where 1=1) s;`),
    ["delete-without-where"],
  ],
  [
    "G1 drop rồi create cùng tên",
    T(`drop table if exists "x";`) + "\n" + T(`create table "x" ("id" text not null primary key);`),
    ["drop-table"],
  ],
  [
    "G2 create if not exists bảng đã có rồi drop",
    T(`create table if not exists "x" ("id" text not null primary key);`) + "\n" + T(`drop table "x";`),
    ["drop-table"],
  ],
  [
    "G3 add if not exists cột đã có rồi đổi kiểu",
    T(`alter table "x" add column if not exists "amount" int null;`) +
      "\n" +
      T(`alter table "x" alter column "amount" type bigint using "amount"::bigint;`),
    ["alter-column-type"],
  ],
  [
    "G4 thêm cột NOT NULL không DEFAULT",
    T(`alter table "x" add column "must" text not null;`),
    ["add-required-column"],
  ],
  [
    "G5 CHECK IS NOT NULL (không phải luật)",
    T(`alter table "x" add constraint "x_amount_nn" check ("amount" is not null);`),
    [],
  ],
  ["G6 drop index tên không có trên base", T(`drop index if exists "IDX_x_col_unique";`), []],
  ["G7 drop PK do base tạo", T(`alter table "x" drop constraint "x_pkey";`), ["drop-constraint"]],
  [
    "G8 drop view/function/type",
    T(`drop view if exists "v_x"; drop function if exists f_x(); drop type if exists t_x;`),
    ["drop-object"],
  ],
  ["G9 set schema", T(`alter table "x" set schema archive;`), ["rename-table"]],
  ["G10 update không WHERE (backfill hợp lệ, không phải luật)", T(`update "x" set "col" = null;`), []],
  [
    "G11 chuỗi E'' giấu lệnh",
    "    this.addSql(`select E'\\\\''; alter table \"x\" drop column \"col\"; select '';`);",
    ["drop-column"],
  ],
  [
    "H1 thêm cột, backfill, SET NOT NULL",
    T(`alter table "x" add column if not exists "c" text null;`) +
      "\n" +
      T(`update "x" set "c" = 'v' where "c" is null;`) +
      "\n" +
      T(`alter table "x" alter column "c" set not null;`),
    ["set-not-null"],
  ],
];

test("ca tái hiện review (A–H): mỗi file migration cho đúng tập luật", async () => {
  for (const [name, up, expected, head = ""] of REVIEW_CASES) {
    const code =
      up === null
        ? `import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20990101000000 extends Migration {
  override up = async (): Promise<void> => {
    this.addSql(\`alter table "x" drop column "col";\`);
  };
  override async down(): Promise<void> {}
}`
        : src(up, { head });
    assert.deepEqual(await errRules(code), expected, name);
  }
});

test("D1: down() dạng arrow không bị quét (không báo nhầm)", async () => {
  const code = `import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20990101000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(\`alter table "x" add column if not exists "z" text null;\`);
  }
  override down = async (): Promise<void> => {
    this.addSql(\`alter table "x" drop column if exists "z";\`);
  };
}`;
  assert.deepEqual((await check(code)).errors, []);
});

/* --------------------------------------------------------------- cờ contract ----------------------------------- */

const contract = (reason, name) =>
  src(adds(`alter table if exists "x" drop column if exists "col";`), {
    head: `// @migration-contract:${reason}`,
    name,
  });

test("cờ contract hợp lệ (lý do + nêu expand có trên base) cho phép thao tác phá huỷ", async () => {
  const r = await check(contract(" bỏ cột cũ, code đọc cột mới từ Migration20260101000000 (đã phát hành)"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.contract, true);
  assert.equal(r.ops.length, 1);
});

test("cờ contract thiếu lý do / lý do ngắn → đỏ (kèm cả thao tác phá huỷ)", async () => {
  for (const reason of ["", "   ", " ngắn"]) {
    const e = (await check(contract(reason))).errors;
    assert.match(e[0], /thiếu lý do/);
    assert.match(e[1], /^drop-column/);
  }
});

test("cờ contract không nêu expand, nêu chính nó (E4), hay expand chưa có ở đâu → đỏ", async () => {
  assert.match(
    (await check(contract(" bỏ cột cũ sau khi đã chuyển đọc sang cột mới"))).errors[0],
    /phải nêu migration expand/,
  );
  assert.match(
    (await check(contract(" bỏ cột cũ, expand ở Migration20990101000000"))).errors[0],
    /không có trên ref gốc/,
  );
  assert.match(
    (await check(contract(" bỏ cột cũ, expand ở Migration20991231000000"))).errors[0],
    /không có trên ref gốc/,
  );
});

test("cờ contract nêu migration CÙNG nhánh: được nếu có trong cây làm việc và sắp trước file này", async () => {
  const earlier = new Set(["Migration20980101000000", "Migration20990101000000", "Migration20991231000000"]);
  assert.deepEqual(
    (await check(contract(" bỏ cột cũ; expand ở Migration20980101000000"), { earlier })).errors,
    [],
  );
  assert.match(
    (await check(contract(" bỏ cột cũ; expand ở Migration20991231000000"), { earlier })).errors[0],
    /không có trên ref gốc/,
  );
  assert.match(
    (await check(contract(" bỏ cột cũ; expand ở Migration20990101000000"), { earlier })).errors[0],
    /không có trên ref gốc/,
  );
});

test("cờ contract chỉ tính trong chú thích TS: JSDoc được; chuỗi (E1), chú thích SQL (E2), regex (E3) thì không", async () => {
  const flag = "@migration-contract: bỏ cột cũ, expand ở Migration20260101000000";
  const up = adds(`alter table "x" drop column "col";`);
  assert.deepEqual((await check(src(up, { head: `/**\n * ${flag}\n */` }))).errors, []);
  assert.equal(contractFlag(src(up, { head: `const note = "// ${flag}";` })), null);
  assert.equal(contractFlag(src(adds(`-- ${flag}\nalter table "x" drop column "col";`))), null);
  assert.equal(contractFlag(src(up, { head: `const re = /${flag}/;` })), null);
  for (const head of [`const note = "// ${flag}";`, `const re = /${flag}/;`])
    assert.deepEqual(await errRules(src(up, { head })), ["drop-column"]);
});

test("cờ contract dư (không có thao tác phá huỷ) không đỏ", async () => {
  const code = src(adds(`alter table "x" add column "b" text null;`), {
    head: "// @migration-contract: expand ở Migration20260101000000 đã phát hành",
  });
  assert.deepEqual((await check(code)).errors, []);
});

/* --------------------------------------------------------------- bất biến (repo git tạm) ------------------------ */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const g = (root, ...args) => execFileSync("git", ["-C", root, ...args], { env: GIT_ENV, encoding: "utf8" });
const commit = (root, msg) => g(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg);
const M = "apps/backend/src/modules";
const MIG = `${M}/shop/migrations`;

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Repo tạm: nhánh `base` có migration tạo bảng x + một migration cũ "vi phạm" (được miễn). */
function fixtureRepo({ attributes } = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-migrations-"));
  g(root, "init", "-q", "-b", "main");
  if (attributes) write(root, ".gitattributes", attributes);
  write(
    root,
    `${MIG}/Migration20260101000000.ts`,
    src(adds(...BASE_SQL), { name: "Migration20260101000000" }),
  );
  write(
    root,
    `${MIG}/Migration20260102000000.ts`,
    src(adds(`alter table "x" drop column "legacy";`), { name: "Migration20260102000000" }),
  );
  write(root, `${MIG}/.snapshot-shop.json`, "{}\n");
  g(root, "add", "-A");
  commit(root, "base");
  g(root, "branch", "base");
  return root;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: { log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) } };
}

const run = async (root, opts = {}) => {
  const c = capture();
  const code = await checkStatic(root, { base: "base", all: false, allow: [], ...opts }, c.log);
  return { code, ...c };
};

test("checkImmutable: so blob hash — sửa, xoá, giữ nguyên", () => {
  const base = new Map([
    ["a.ts", "1"],
    ["b.ts", "2"],
    ["c.ts", "3"],
  ]);
  const now = new Map([
    ["a.ts", "1"],
    ["b.ts", "9"],
  ]);
  assert.deepEqual(checkImmutable(base, now), [
    { file: "b.ts", kind: "modified" },
    { file: "c.ts", kind: "deleted" },
  ]);
});

test("repo tạm: không đổi gì → xanh; migration vi phạm đã có trên base được miễn; --all bắt", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = await run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /2 migration trên base giữ nguyên byte; 0 migration mới/);
  const all = await run(root, { all: true });
  assert.equal(all.code, 1);
  assert.ok(all.err.some((e) => e.includes("Migration20260102000000.ts: drop-column")));
  // --all: migration tạo bảng x so với schema TRƯỚC nó (rỗng) → không báo nhầm
  assert.ok(!all.err.some((e) => e.includes("Migration20260101000000.ts")));
});

test("repo tạm: migration cũ bị sửa (chưa commit hay đã commit) → đỏ, in tên file", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${MIG}/Migration20260101000000.ts`;
  writeFileSync(join(root, f), readFileSync(join(root, f), "utf8") + "// sửa nhẹ\n");
  let r = await run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("bị sửa")));
  g(root, "-c", "commit.gpgsign=false", "commit", "-qam", "edit");
  r = await run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("bị sửa")));
});

test("repo tạm: CRLF do checkout (.gitattributes eol=crlf) không bị coi là sửa; đổi nội dung thật vẫn bị bắt", async (t) => {
  const root = fixtureRepo({ attributes: "*.ts text eol=crlf\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${MIG}/Migration20260101000000.ts`;
  const lf = readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n");
  writeFileSync(join(root, f), lf.replace(/\n/g, "\r\n")); // như sau checkout trên máy dùng CRLF
  let r = await run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  writeFileSync(join(root, f), lf.replace(/\n/g, "\r\n").replace("bigint", "integer"));
  r = await run(root);
  assert.equal(r.code, 1);
});

test("repo tạm: migration cũ bị xoá hoặc di chuyển → đỏ; snapshot đổi thì không", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${MIG}/Migration20260102000000.ts`;
  g(root, "mv", f, `${MIG}/Migration20260102000001.ts`);
  writeFileSync(join(root, `${MIG}/.snapshot-shop.json`), '{"tables":[]}\n');
  const r = await run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("xoá/di chuyển")));
  assert.ok(r.err.some((e) => e.includes("Migration20260102000001.ts: drop-column")));
  assert.ok(!r.err.some((e) => e.includes(".snapshot-shop.json")));
});

test("repo tạm: migration mới so với schema base — vi phạm → đỏ; hợp lệ → xanh", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${MIG}/Migration20260103000000.ts`;
  write(root, f, src(adds(`alter table "x" drop constraint "x_pkey";`)));
  let r = await run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("drop-constraint")));
  write(
    root,
    f,
    src(
      adds(
        `alter table "x" add column if not exists "amount" int;`,
        `alter table "x" alter column "amount" type text;`,
      ),
    ),
  );
  r = await run(root);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("alter-column-type")));
  write(
    root,
    f,
    src(adds(`alter table "x" add column "y" text null;`), {
      down: adds(`alter table "x" drop column "y";`),
    }),
  );
  r = await run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /1 migration mới đạt/);
});

test("repo tạm: contract nêu expand trên base hoặc migration sắp trước trong nhánh → xanh", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, `${MIG}/Migration20260103000000.ts`, src(adds(`alter table "x" add column "col2" text null;`)));
  write(
    root,
    `${MIG}/Migration20260104000000.ts`,
    src(adds(`alter table "x" drop column "col";`), {
      head: "// @migration-contract: bỏ cột col; expand ở Migration20260103000000",
    }),
  );
  const r = await run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /1 có cờ contract/);
});

test("ref gốc không có (clone nông/chưa fetch) → exit 2, thông báo rõ", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = await run(root, { base: "origin/master" });
  assert.equal(r.code, 2);
  assert.match(r.err[0], /ref gốc "origin\/master" không có/);
});

test("allowlist: khớp vi phạm → xanh; mục nát, thiếu lý do → đỏ; file đã lên base → chỉ nhắc", async (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${MIG}/Migration20260105000000.ts`;
  write(root, f, src(adds(`alter table "x" alter column "col" set not null;`)));
  const reason = "mọi đường ghi bản N−1 đã ghi giá trị; up() kiểm NULL trước";
  assert.equal((await run(root, { allow: [{ file: f, rule: "set-not-null", reason }] })).code, 0);
  const wrongRule = await run(root, { allow: [{ file: f, rule: "drop-column", reason }] });
  assert.equal(wrongRule.code, 1);
  assert.ok(wrongRule.err.some((e) => e.includes("không khớp vi phạm nào")));
  assert.ok(wrongRule.err.some((e) => e.includes("NOT VALID") && e.includes("VALIDATE")));
  const short = await run(root, { allow: [{ file: f, rule: "set-not-null", reason: "ok" }] });
  assert.equal(short.code, 1);
  assert.ok(short.err.some((e) => e.includes("thiếu lý do")));
  const old = `${MIG}/Migration20260102000000.ts`;
  const exempt = await run(root, {
    allow: [
      { file: f, rule: "set-not-null", reason },
      { file: old, rule: "drop-column", reason },
    ],
  });
  assert.equal(exempt.code, 0, exempt.err.join("\n"));
  assert.ok(exempt.out.some((m) => m.includes(old) && m.includes("xoá mục này")));
  const missing = await run(root, { allow: [{ file: `${MIG}/MigrationX.ts`, rule: "drop-table", reason }] });
  assert.equal(missing.code, 1);
});

test("ALLOW của repo: mỗi mục có lý do đủ dài và trỏ tới file có thật", () => {
  const root = join(here, "..");
  for (const a of ALLOW) {
    assert.ok(a.reason.length >= 20, a.file);
    assert.ok(existsSync(join(root, a.file)), a.file);
  }
});

test("main: tham số lạ → 2", async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(["--bogus"]), 2);
    assert.equal(await main(["--base"]), 2);
  } finally {
    console.error = orig;
  }
});

/* --------------------------------------------------------------- drift (I/O giả) -------------------------------- */

function driftRepo() {
  const root = mkdtempSync(join(tmpdir(), "check-migrations-drift-"));
  write(
    root,
    `${M}/shop/index.ts`,
    `export const SHOP_MODULE = "xShop";\nexport default Module(SHOP_MODULE, { service: S });\n`,
  );
  write(root, `${M}/shop/models/a.ts`, "export const A = 1;\n");
  write(root, `${M}/shop/migrations/.snapshot-x-shop.json`, '{"tables":[]}\n');
  write(root, `${M}/shop/migrations/Migration20260101000000.ts`, "// cũ\n");
  write(root, `${M}/raw/index.ts`, `export default Module("raw", { service: S });\n`);
  write(root, `${M}/raw/migrations/Migration20260101000001.ts`, "// SQL tay, không model\n");
  write(root, `${M}/__tests__/x.test.ts`, "\n");
  return root;
}

const SKIPPED = "Skipped. No changes detected in your models.";

/** deps giả: ghi lại lệnh SQL quản trị + lệnh chạy; `onGenerate` mô phỏng db:generate (trả output). */
function fakeDeps(root, { onGenerate, failCreate = false, env = {} } = {}) {
  const admin = [];
  const cmds = [];
  const proc = new EventEmitter();
  proc.exitCodes = [];
  proc.exit = (code) => proc.exitCodes.push(code);
  return {
    admin,
    cmds,
    proc,
    deps: {
      env,
      proc,
      admin: async (sql) => {
        admin.push(sql);
        if (failCreate && sql.startsWith("CREATE")) throw new Error("database exists");
      },
      run: async (cmd, args, o) => {
        cmds.push({ args: args.join(" "), url: o?.env?.DATABASE_URL });
        if (!args.includes("db:generate")) return "";
        const n = args.length - args.indexOf("db:generate") - 1;
        return onGenerate ? onGenerate(root, n) : Array(n).fill(SKIPPED).join("\n");
      },
    },
  };
}

test("customModules: đọc tên module (hằng hoặc literal), bỏ module không có models/", (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(customModules(root), [{ dir: "shop", name: "xShop" }]);
  write(root, `${M}/raw/models/b.ts`, "\n");
  assert.deepEqual(
    customModules(root).map((m) => m.name),
    ["raw", "xShop"],
  );
});

test("diffSnapshots: thêm/đổi/xoá", () => {
  const before = new Map([
    ["a", "1"],
    ["b", "2"],
  ]);
  const after = new Map([
    ["a", "1"],
    ["b", "3"],
    ["c", "4"],
  ]);
  assert.deepEqual(diffSnapshots(before, after), [
    { file: "b", kind: "changed" },
    { file: "c", kind: "added" },
  ]);
  assert.deepEqual(diffSnapshots(after, before), [
    { file: "b", kind: "changed" },
    { file: "c", kind: "removed" },
  ]);
});

test("parseGenerateOutput: đếm Generated/Skipped, gom dòng Failed with error (log JSON của Medusa)", () => {
  const out = [
    '{"level":"info","message":"MODULE: a"}',
    '{"level":"info","message":"Skipped. No changes detected in your models."}',
    '{"level":"info","message":"Generated successfully (Migration1.ts)."}',
    '{"level":"error","message":"Failed with error /x/.snapshot-b.json: Unexpected non-whitespace"}',
  ].join("\n");
  const r = parseGenerateOutput(out);
  assert.equal(r.done, 2);
  assert.deepEqual(r.failures, ["Failed with error /x/.snapshot-b.json: Unexpected non-whitespace"]);
});

test("drift: db:generate không sinh gì → 0; migrate rồi generate đúng module, trên DB riêng, xoá DB sau", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fakeDeps(root, { env: { DRIFT_DB_NAME: "xshop_t102" } });
  const c = capture();
  assert.equal(await checkDrift(root, {}, f.deps, c.log), 0, c.err.join("\n"));
  assert.deepEqual(f.admin, [
    'CREATE DATABASE "xshop_t102"',
    'DROP DATABASE IF EXISTS "xshop_t102" WITH (FORCE)',
  ]);
  assert.deepEqual(
    f.cmds.map((x) => x.args),
    ["--filter @x-shop/domain build", "exec medusa db:migrate --skip-links", "exec medusa db:generate xShop"],
  );
  assert.ok(f.cmds.slice(1).every((x) => x.url === "postgres://xshop:xshop@localhost:5432/xshop_t102"));
  assert.equal(f.proc.listenerCount("SIGINT") + f.proc.listenerCount("SIGTERM"), 0);
});

test("drift: db:generate nuốt lỗi (snapshot hỏng → 'Failed with error', thoát 0) → 2, không báo xanh", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snap = join(root, `${MIG}/.snapshot-x-shop.json`);
  writeFileSync(snap, JSON.stringify({ tables: [{ name: "a", columns: null }] }));
  const f = fakeDeps(root, {
    onGenerate: () =>
      `{"level":"info","message":"MODULE: xShop"}\n{"level":"error","message":"Failed with error ${snap}: Cannot convert undefined or null to object"}\n{"message":"Migrations generated"}`,
  });
  const c = capture();
  assert.equal(await checkDrift(root, {}, f.deps, c.log), 2);
  assert.ok(c.err.some((e) => e.includes("Failed with error")));
  assert.ok(c.err.some((e) => e.includes("0/1 module")));
  // thiếu dòng của một module (không lỗi, không skipped) cũng → 2
  const g2 = fakeDeps(root, { onGenerate: () => "Migrations generated" });
  assert.equal(await checkDrift(root, {}, g2.deps, capture().log), 2);
  assert.equal(g2.admin.filter((s) => s.startsWith("DROP")).length, 1);
});

test("drift: db:generate sinh migration + đổi snapshot → 1, in nội dung, trả file về như cũ", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fakeDeps(root, {
    onGenerate: (r) => {
      writeFileSync(
        join(r, MIG, "Migration20990101000000.ts"),
        'this.addSql(`alter table "a" add column "z" text;`);\n',
      );
      writeFileSync(join(r, MIG, ".snapshot-x-shop.json"), '{"tables":["a"]}\n');
      return "Generated successfully (Migration20990101000000.ts).";
    },
  });
  const c = capture();
  assert.equal(await checkDrift(root, {}, f.deps, c.log), 1);
  assert.ok(c.err.some((e) => e.includes("Migration20990101000000.ts (added)")));
  assert.ok(c.err.some((e) => e.includes('add column "z"')));
  assert.ok(c.err.some((e) => e.includes(".snapshot-x-shop.json (changed)")));
  assert.equal(existsSync(join(root, MIG, "Migration20990101000000.ts")), false);
  assert.equal(readFileSync(join(root, MIG, ".snapshot-x-shop.json"), "utf8"), '{"tables":[]}\n');
  assert.equal(f.admin.filter((s) => s.startsWith("DROP")).length, 1);
});

test("drift: --keep-generated giữ file sinh ra để soát", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = join(root, `${MIG}/Migration20990101000000.ts`);
  const f = fakeDeps(root, {
    onGenerate: () => {
      writeFileSync(p, "x\n");
      return "Generated successfully (x).";
    },
  });
  assert.equal(await checkDrift(root, { keepGenerated: true }, f.deps, capture().log), 1);
  assert.equal(existsSync(p), true);
});

test("drift: tên DB không an toàn → 2, không lệnh nào tới máy chủ", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["xshop", "postgres", 'xshop_a"; drop database xshop; --', "XSHOP_T102"]) {
    const f = fakeDeps(root, { env: { DRIFT_DB_NAME: name } });
    assert.equal(await checkDrift(root, {}, f.deps, capture().log), 2, name);
    assert.deepEqual(f.admin, []);
  }
});

test("drift: CREATE lỗi (DB trùng tên đã có) → 2 và KHÔNG DROP DB của người khác", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fakeDeps(root, { failCreate: true, env: { DRIFT_DB_NAME: "xshop_e2e" } });
  assert.equal(await checkDrift(root, {}, f.deps, capture().log), 2);
  assert.deepEqual(f.admin, ['CREATE DATABASE "xshop_e2e"']);
});

test("drift: migrate lỗi → 2, vẫn xoá DB đã tạo", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fakeDeps(root);
  f.deps.run = async (cmd, args) => {
    if (args.includes("db:migrate")) throw new Error("boom");
    return "";
  };
  assert.equal(await checkDrift(root, {}, f.deps, capture().log), 2);
  assert.equal(f.admin.length, 2);
  assert.match(f.admin[1], /^DROP DATABASE IF EXISTS "xshop_drift_[0-9a-f]{12}"/);
});

test("drift: SIGTERM giữa chừng → trả file, xoá DB đúng một lần, thoát 143", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fakeDeps(root);
  const gen = join(root, MIG, "Migration20990101000000.ts");
  f.deps.run = async (cmd, args) => {
    if (args.includes("db:migrate")) {
      writeFileSync(gen, "x\n");
      f.proc.emit("SIGTERM", "SIGTERM");
      await new Promise((r) => setImmediate(r));
      throw new Error("bị ngắt");
    }
    return "";
  };
  assert.equal(await checkDrift(root, {}, f.deps, capture().log), 2);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.proc.exitCodes, [143]);
  assert.equal(f.admin.filter((s) => s.startsWith("DROP")).length, 1);
  assert.equal(existsSync(gen), false);
});

test("drift đồng thời: hai lần chạy song song dùng hai DB khác tên, mỗi lần chỉ xoá DB của mình", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = fakeDeps(root);
  const b = fakeDeps(root);
  const [ra, rb] = await Promise.all([
    checkDrift(root, {}, a.deps, capture().log),
    checkDrift(root, {}, b.deps, capture().log),
  ]);
  assert.deepEqual([ra, rb], [0, 0]);
  const name = (admin) => /"(.+)"/.exec(admin[0])[1];
  assert.notEqual(name(a.admin), name(b.admin));
  assert.ok(a.admin[1].includes(name(a.admin)) && b.admin[1].includes(name(b.admin)));
});

test("emptySchema/applySchema: bảng, cột (create table + add column), tên ràng buộc/index", () => {
  const s = applySchema(
    [
      ...BASE_SQL,
      `alter table "x" add column if not exists "z" text null, add constraint "x_z_len" check (length("z") < 9);`,
    ],
    emptySchema(),
  );
  assert.deepEqual([...s.tables], ["x"]);
  assert.deepEqual([...s.columns].sort(), ["x.amount", "x.col", "x.id", "x.z"]);
  assert.deepEqual([...s.names].sort(), ["idx_x_amount", "x_amount_nonneg", "x_pkey", "x_z_len"]);
});
