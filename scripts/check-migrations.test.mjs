import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ALLOW,
  checkDrift,
  checkExpandContract,
  checkImmutable,
  checkStatic,
  customModules,
  destructiveOps,
  diffSnapshots,
  main,
  normalizeSql,
} from "./check-migrations.mjs";

const rules = (...sql) => destructiveOps(sql).map((o) => o.rule);

/** Migration TS tối thiểu: `up` và `down` là danh sách câu SQL; `head` chèn trước class (chú thích, hằng). */
const mig = (
  up,
  down = [],
  head = "",
) => `import { Migration } from "@medusajs/framework/mikro-orm/migrations";
${head}
export class Migration20990101000000 extends Migration {
  override async up(): Promise<void> {
${up.map((s) => `    this.addSql(\`${s}\`);`).join("\n")}
  }

  override async down(): Promise<void> {
${down.map((s) => `    this.addSql(\`${s}\`);`).join("\n")}
  }
}
`;

const BASE = new Set(["Migration20261027100000"]);
const errs = (src, base = BASE, allow) => checkExpandContract(src, base, allow).errors;

/* --------------------------------------------------------------- normalizeSql ---------------------------------- */

test("normalizeSql: bỏ chú thích SQL, chuỗi '…' thành '', định danh thành token, chữ thường", () => {
  const { text, idents } = normalizeSql(
    `ALTER TABLE "Order" -- drop table x\n /* truncate y */ ADD "a" text default 'drop table z';`,
  );
  assert.equal(text, "alter table ⟦0⟧ add ⟦1⟧ text default '';");
  assert.deepEqual(idents, ["order", "a"]);
  assert.equal(normalizeSql(`select 'it''s; drop table x'`).text, "select ''");
});

/* --------------------------------------------------------------- từng luật ------------------------------------- */

test("drop-table: bắt drop table (kể cả if exists, nhiều bảng); miễn bảng tạo trong cùng file", () => {
  assert.deepEqual(rules(`drop table if exists "x_order";`), ["drop-table"]);
  assert.deepEqual(rules(`DROP TABLE a, b CASCADE`), ["drop-table"]);
  assert.deepEqual(rules(`create table if not exists "tmp" ("id" text);`, `drop table "tmp";`), []);
  assert.deepEqual(rules(`create table "tmp" ("id" text); drop table "tmp", "other";`), ["drop-table"]);
});

test("drop-column: có/không từ khoá COLUMN, trong danh sách hành động; drop constraint thì không", () => {
  assert.deepEqual(rules(`alter table if exists "q" drop column if exists "shipping";`), ["drop-column"]);
  assert.deepEqual(rules(`alter table q drop shipping`), ["drop-column"]);
  assert.deepEqual(rules(`alter table "r" add column "a" text null, drop column "b";`), ["drop-column"]);
  assert.deepEqual(rules(`alter table if exists "q" drop constraint if exists "q_kind_check";`), []);
});

test("rename-table / rename-column; rename constraint và ALTER INDEX … RENAME được phép", () => {
  assert.deepEqual(rules(`alter table "a" rename to "b";`), ["rename-table"]);
  assert.deepEqual(rules(`alter table "a" rename column "x" to "y";`), ["rename-column"]);
  assert.deepEqual(rules(`ALTER TABLE ONLY public."a" RENAME x TO y`), ["rename-column"]);
  assert.deepEqual(rules(`alter table "a" rename constraint "c1" to "c2";`), []);
  assert.deepEqual(rules(`alter index "IDX_a" rename to "IDX_b";`), []);
});

test("alter-column-type: TYPE và SET DATA TYPE; miễn cột vừa thêm trong cùng file", () => {
  assert.deepEqual(rules(`alter table "t" alter column "amount" type bigint;`), ["alter-column-type"]);
  assert.deepEqual(rules(`alter table t alter amount set data type numeric using amount::numeric`), [
    "alter-column-type",
  ]);
  assert.deepEqual(
    rules(
      `alter table "t" add column if not exists "n" int;`,
      `alter table "t" alter column "n" type bigint;`,
    ),
    [],
  );
  assert.deepEqual(
    rules(
      `alter table "t" alter column "a" set default 0;`,
      `alter table "t" alter column "a" drop not null;`,
    ),
    [],
  );
});

test("set-not-null: cột có sẵn bị bắt; cột/bảng tạo trong cùng file được miễn", () => {
  assert.deepEqual(rules(`alter table "t" alter column "actual_amount" set not null;`), ["set-not-null"]);
  assert.deepEqual(
    rules(`alter table "t" add column "c" text null;`, `alter table "t" alter column "c" set not null;`),
    [],
  );
  assert.deepEqual(
    rules(`create table "t2" ("c" text null);`, `alter table "t2" alter column "c" set not null;`),
    [],
  );
  // cột cùng tên ở BẢNG KHÁC không được miễn
  assert.deepEqual(
    rules(`alter table "t" add column "c" text;`, `alter table "u" alter column "c" set not null;`),
    ["set-not-null"],
  );
  // thêm ràng buộc không phải thêm cột
  assert.deepEqual(
    rules(
      `alter table "t" add constraint "c" check (1=1);`,
      `alter table "t" alter column "constraint" set not null;`,
    ),
    ["set-not-null"],
  );
});

test("truncate và delete không WHERE bị bắt; delete có WHERE (kể cả trong DO $$) thì không", () => {
  assert.deepEqual(rules(`truncate table "audit_log";`), ["truncate"]);
  assert.deepEqual(rules(`delete from "x_refund";`), ["delete-without-where"]);
  assert.deepEqual(rules(`delete from "x_refund" where "state" = 'x';`), []);
  assert.deepEqual(rules(`do $$ begin delete from "t"; end $$;`), ["delete-without-where"]);
  assert.deepEqual(rules(`do $$ begin delete from "t" where id = 1; end $$;`), []);
  // trigger "before update or delete" không phải lệnh DELETE
  assert.deepEqual(
    rules(`create trigger g before update or delete on "a" for each row execute function f();`),
    [],
  );
});

test("mẫu idempotent hợp lệ: drop constraint/index if exists rồi tạo lại, create/add thường — không báo", () => {
  const src = mig([
    `alter table if exists "o" drop constraint if exists "o_kind_check";`,
    `alter table if exists "o" add constraint "o_kind_check" check("kind" in ('a', 'b'));`,
    `drop index if exists "IDX_r";`,
    `create unique index if not exists "IDX_r" on "r" ("a") where "a" is not null;`,
    `alter table "r" add column if not exists "b" text null;`,
    `drop trigger if exists "g" on "a";`,
  ]);
  assert.deepEqual(errs(src), []);
});

/* --------------------------------------------------------------- phạm vi quét ---------------------------------- */

test("down() không bị chặn; up() thì có", () => {
  assert.deepEqual(
    errs(mig([`alter table "q" add column "s" jsonb null;`], [`alter table "q" drop column "s";`])),
    [],
  );
  const e = errs(mig([`alter table "q" drop column "s";`]));
  assert.equal(e.length, 1);
  assert.match(e[0], /^drop-column trong up\(\)/);
});

test("ca biên: chú thích TS/SQL và chuỗi '…' chứa DROP không gây báo; SQL ở hằng cấp module dùng trong up() vẫn bị quét", () => {
  const head = `/** up() không DROP TABLE hay DROP COLUMN gì cả — chỉ thêm cột. */\n// truncate là việc của công cụ test`;
  assert.deepEqual(
    errs(
      mig(
        [
          `alter table "a" add column "b" text null; -- sau này sẽ drop column "c"`,
          `do $$ begin raise exception 'không được drop table "a"'; end $$;`,
        ],
        [],
        head,
      ),
    ),
    [],
  );
  const viaConst = mig([], [], `const SQL = \`alter table "a" drop column "b";\`;`).replace(
    "override async up(): Promise<void> {",
    "override async up(): Promise<void> {\n    this.addSql(SQL);",
  );
  assert.equal(errs(viaConst).length, 1);
});

test("định danh nội suy ${…} trong template vẫn được hiểu", () => {
  const head = `const C = { table: "t", col: "c" };`;
  const src = mig([`alter table "\${C.table}" alter column "\${C.col}" set not null;`], [], head);
  assert.match(errs(src)[0], /set-not-null/);
});

test("file không có up() → lỗi", () => {
  assert.deepEqual(errs(`export class M { async down() { this.addSql("drop table x"); } }`), [
    "không tìm thấy thân `up()`",
  ]);
});

/* --------------------------------------------------------------- cờ contract ----------------------------------- */

const contract = (reason) =>
  mig(
    [`alter table if exists "checkout_quote" drop column if exists "shipping_old";`],
    [],
    `// @migration-contract:${reason}`,
  );

test("cờ contract hợp lệ (lý do + nêu migration expand có trên base) cho phép thao tác phá huỷ", () => {
  const r = checkExpandContract(
    contract(" bỏ cột cũ, code đọc cột mới từ Migration20261027100000 (đã phát hành)"),
    BASE,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.contract, true);
  assert.equal(r.ops.length, 1);
});

test("cờ contract thiếu lý do / lý do ngắn → đỏ (kèm cả thao tác phá huỷ)", () => {
  for (const reason of ["", "   ", " ngắn"]) {
    const e = errs(contract(reason));
    assert.match(e[0], /thiếu lý do/);
    assert.match(e[1], /^drop-column/);
  }
});

test("cờ contract không nêu migration expand, hoặc expand chưa có trên base → đỏ", () => {
  assert.match(
    errs(contract(" bỏ cột cũ sau khi đã chuyển đọc sang cột mới"))[0],
    /phải nêu migration expand/,
  );
  assert.match(
    errs(contract(" bỏ cột cũ, expand ở Migration20991231000000 cùng PR"))[0],
    /chưa có trên ref gốc/,
  );
});

test("cờ contract trong chú thích khối JSDoc được nhận; nằm trong chuỗi thì không", () => {
  const block = mig(
    [`alter table "a" drop column "b";`],
    [],
    `/**\n * @migration-contract: expand ở Migration20261027100000 đã phát hành\n */`,
  );
  assert.deepEqual(errs(block), []);
  const inString = mig(
    [`alter table "a" drop column "b";`],
    [],
    `const s = "@migration-contract: expand ở Migration20261027100000 đã phát hành";`,
  );
  assert.equal(errs(inString).length, 1);
});

test("cờ contract dư (không có thao tác phá huỷ) không đỏ", () => {
  const src = mig(
    [`alter table "a" add column "b" text null;`],
    [],
    `// @migration-contract: expand ở Migration20261027100000 đã phát hành`,
  );
  assert.deepEqual(errs(src), []);
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
const M = "apps/backend/src/modules";

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Repo tạm: commit gốc (nhánh `base`) có một migration hợp lệ + một migration cũ "vi phạm" (được miễn). */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "check-migrations-"));
  g(root, "init", "-q", "-b", "main");
  write(root, `${M}/shop/migrations/Migration20260101000000.ts`, mig([`create table "a" ("id" text);`]));
  write(
    root,
    `${M}/shop/migrations/Migration20260102000000.ts`,
    mig([`alter table "a" drop column "legacy";`]),
  );
  write(root, `${M}/shop/migrations/.snapshot-shop.json`, "{}\n");
  g(root, "add", "-A");
  g(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  g(root, "branch", "base");
  return root;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: { log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) } };
}

const run = (root, opts = {}) => {
  const c = capture();
  const code = checkStatic(root, { base: "base", all: false, allow: [], ...opts }, c.log);
  return { code, ...c };
};

test("checkImmutable: so blob hash — sửa, xoá, giữ nguyên", () => {
  const base = new Map([
    ["a.ts", "1"],
    ["b.ts", "2"],
    ["c.ts", "3"],
  ]);
  assert.deepEqual(
    checkImmutable(
      base,
      new Map([
        ["a.ts", "1"],
        ["b.ts", "9"],
      ]),
    ),
    [
      { file: "b.ts", kind: "modified" },
      { file: "c.ts", kind: "deleted" },
    ],
  );
});

test("repo tạm: không đổi gì → xanh; migration vi phạm đã có trên base được miễn (chỉ kiểm bất biến)", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /2 migration trên base giữ nguyên byte; 0 migration mới/);
  // --all soát cả migration cũ → bắt vi phạm của bản cũ
  const all = run(root, { all: true });
  assert.equal(all.code, 1);
  assert.ok(all.err.some((e) => e.includes("Migration20260102000000.ts: drop-column")));
});

test("repo tạm: migration cũ bị sửa (chưa commit hay đã commit) → đỏ, in tên file", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${M}/shop/migrations/Migration20260101000000.ts`;
  writeFileSync(join(root, f), readFileSync(join(root, f), "utf8") + "// sửa nhẹ\n");
  let r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("bị sửa")));
  g(root, "-c", "commit.gpgsign=false", "commit", "-qam", "edit");
  r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("bị sửa")));
});

test("repo tạm: migration cũ bị xoá hoặc di chuyển → đỏ; snapshot đổi thì không", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${M}/shop/migrations/Migration20260102000000.ts`;
  g(root, "mv", f, `${M}/shop/migrations/Migration20260102000001.ts`);
  writeFileSync(join(root, `${M}/shop/migrations/.snapshot-shop.json`), '{"tables":[]}\n');
  const r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(f) && e.includes("xoá/di chuyển")));
  // file "mới" sau khi di chuyển cũng phải qua luật expand/contract
  assert.ok(r.err.some((e) => e.includes("Migration20260102000001.ts: drop-column")));
  assert.ok(!r.err.some((e) => e.includes(".snapshot-shop.json")));
});

test("repo tạm: migration mới vi phạm → đỏ; mới hợp lệ → xanh", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bad = `${M}/shop/migrations/Migration20260103000000.ts`;
  write(root, bad, mig([`alter table "a" rename column "x" to "y";`]));
  let r = run(root);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((e) => e.includes(bad) && e.includes("rename-column")));
  write(root, bad, mig([`alter table "a" add column "y" text null;`], [`alter table "a" drop column "y";`]));
  r = run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /1 migration mới đạt/);
});

test("repo tạm: contract nêu migration expand có trên base → xanh", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    `${M}/shop/migrations/Migration20260104000000.ts`,
    mig(
      [`alter table "a" drop column "old";`],
      [],
      "// @migration-contract: bỏ cột cũ; expand ở Migration20260101000000",
    ),
  );
  const r = run(root);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out[0], /1 có cờ contract/);
});

test("ref gốc không có (clone nông/chưa fetch) → exit 2, thông báo rõ", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = run(root, { base: "origin/master" });
  assert.equal(r.code, 2);
  assert.match(r.err[0], /ref gốc "origin\/master" không có/);
});

test("allowlist: khớp vi phạm → xanh; mục nát, thiếu lý do → đỏ; file đã lên base → chỉ nhắc", (t) => {
  const root = fixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = `${M}/shop/migrations/Migration20260105000000.ts`;
  write(root, f, mig([`alter table "a" alter column "b" set not null;`]));
  const reason = "mọi đường ghi bản N−1 đã ghi giá trị; up() kiểm NULL trước";
  assert.equal(run(root, { allow: [{ file: f, rule: "set-not-null", reason }] }).code, 0);
  const wrongRule = run(root, { allow: [{ file: f, rule: "drop-column", reason }] });
  assert.equal(wrongRule.code, 1);
  assert.ok(wrongRule.err.some((e) => e.includes("không khớp vi phạm nào")));
  const short = run(root, { allow: [{ file: f, rule: "set-not-null", reason: "ok" }] });
  assert.equal(short.code, 1);
  assert.ok(short.err.some((e) => e.includes("thiếu lý do")));
  const old = `${M}/shop/migrations/Migration20260102000000.ts`;
  const exempt = run(root, {
    allow: [
      { file: f, rule: "set-not-null", reason },
      { file: old, rule: "drop-column", reason },
    ],
  });
  assert.equal(exempt.code, 0, exempt.err.join("\n"));
  assert.ok(exempt.out.some((m) => m.includes(old) && m.includes("xoá mục này")));
  const missing = run(root, {
    allow: [{ file: `${M}/shop/migrations/MigrationX.ts`, rule: "drop-table", reason }],
  });
  assert.equal(missing.code, 1);
});

test("ALLOW của repo: mỗi mục có lý do đủ dài và trỏ tới file có thật", () => {
  const root = join(dirname(new URL(import.meta.url).pathname), "..");
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

/** deps giả: ghi lại lệnh SQL quản trị + lệnh chạy; `onGenerate` mô phỏng db:generate. */
function fakeDeps(root, { onGenerate = () => {}, failCreate = false, env = {} } = {}) {
  const admin = [];
  const cmds = [];
  return {
    admin,
    cmds,
    deps: {
      env,
      admin: async (sql) => {
        admin.push(sql);
        if (failCreate && sql.startsWith("CREATE")) throw new Error("database exists");
      },
      run: async (cmd, args, o) => {
        cmds.push({ args: args.join(" "), url: o?.env?.DATABASE_URL });
        if (args.includes("db:generate")) onGenerate(root);
        return "";
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
});

test("drift: db:generate sinh migration + đổi snapshot → 1, in nội dung, trả file về như cũ", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = `${M}/shop/migrations`;
  const f = fakeDeps(root, {
    onGenerate: (r) => {
      writeFileSync(
        join(r, dir, "Migration20990101000000.ts"),
        'this.addSql(`alter table "a" add column "z" text;`);\n',
      );
      writeFileSync(join(r, dir, ".snapshot-x-shop.json"), '{"tables":["a"]}\n');
    },
  });
  const c = capture();
  assert.equal(await checkDrift(root, {}, f.deps, c.log), 1);
  assert.ok(c.err.some((e) => e.includes("Migration20990101000000.ts (added)")));
  assert.ok(c.err.some((e) => e.includes('add column "z"')));
  assert.ok(c.err.some((e) => e.includes(".snapshot-x-shop.json (changed)")));
  assert.equal(existsSync(join(root, dir, "Migration20990101000000.ts")), false);
  assert.equal(readFileSync(join(root, dir, ".snapshot-x-shop.json"), "utf8"), '{"tables":[]}\n');
  assert.equal(f.admin.filter((s) => s.startsWith("DROP")).length, 1);
});

test("drift: --keep-generated giữ file sinh ra để soát", async (t) => {
  const root = driftRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = join(root, `${M}/shop/migrations/Migration20990101000000.ts`);
  const f = fakeDeps(root, { onGenerate: () => writeFileSync(p, "x\n") });
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
