import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE as CHECK_MIGRATIONS_DEFAULT_BASE, listMigrations } from "./check-migrations.mjs";
import {
  DEFAULT_PG_BASE,
  N1_ALLOW,
  SAFE_DB,
  SCHEMA_SQL,
  applyAllow,
  buildSteps,
  caseName,
  CONFIRM_RUNS,
  SUITE_ERROR,
  classifyCases,
  isLocalDbUrl,
  dbNames,
  diffSchemas,
  failedCases,
  failedDetails,
  failedSuites,
  formatDuration,
  hasChanges,
  medusaLockChange,
  medusaPackages,
  migrationChanges,
  moduleOf,
  normalizeDefault,
  parseArgs,
  pgBaseUrl,
  planOverlay,
  realDeps,
  run,
  schemaFromRows,
  validateAllow,
} from "./n-minus-1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const M = (mod, name) => `apps/backend/src/modules/${mod}/migrations/${name}.ts`;

/* ---------------------------------------------------------- chọn ref gốc --------------------------------------- */

test("parseArgs: ref gốc cùng quy tắc check-migrations (--base > MIGRATIONS_BASE_REF > origin/master)", () => {
  assert.equal(parseArgs([], {}).base, CHECK_MIGRATIONS_DEFAULT_BASE);
  assert.equal(parseArgs([], {}).base, "origin/master");
  assert.equal(parseArgs([], { MIGRATIONS_BASE_REF: "abc123" }).base, "abc123");
  assert.equal(parseArgs(["--base", "HEAD~3"], { MIGRATIONS_BASE_REF: "abc123" }).base, "HEAD~3");
  assert.equal(parseArgs(["--base=origin/dev"], {}).base, "origin/dev");
  // Biến rỗng (CI nội suy ra chuỗi rỗng) → mặc định, không phải ref rỗng.
  assert.equal(parseArgs([], { MIGRATIONS_BASE_REF: "" }).base, "origin/master");
});

test("parseArgs: cờ khác và lỗi tham số", () => {
  const o = parseArgs(
    ["--detect-only", "--keep", "--workdir", "/w", "--test-pattern", "health", "--test-pattern=refund"],
    { N1_WORKDIR: "/khac" },
  );
  assert.deepEqual(o, {
    base: "origin/master",
    detectOnly: true,
    allowRemoteDb: false,
    keep: true,
    workdir: "/w",
    testPatterns: ["health", "refund"],
  });
  assert.equal(parseArgs([], { N1_WORKDIR: "/env" }).workdir, "/env");
  assert.throws(() => parseArgs(["--lạ"], {}), /tham số lạ/);
  assert.throws(() => parseArgs(["--base"], {}), /--base cần/);
  assert.throws(() => parseArgs(["--base", "--keep"], {}), /--base cần/);
  assert.throws(() => parseArgs(["--base="], {}), /--base cần/);
  assert.throws(() => parseArgs(["--test-pattern="], {}), /rỗng/);
});

test("ci.yml: job n-minus-1 dùng ĐÚNG biểu thức ref gốc của bước check-migrations; không phải required check", () => {
  const yml = readFileSync(join(here, "../.github/workflows/ci.yml"), "utf8");
  const expr = (block) => {
    const m = /MIGRATIONS_BASE_REF: >-\n((?:\s+.*\n){3})/.exec(block);
    assert.ok(m, "thiếu MIGRATIONS_BASE_REF");
    return m[1].replace(/\s+/g, " ").trim();
  };
  const jobAt = (name) => {
    const start = yml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
    assert.ok(start >= 0, `thiếu job ${name}`);
    const rest = yml.slice(start + 1);
    const end = rest.search(/^ {2}\S/m);
    return rest.slice(0, end < 0 ? undefined : end);
  };
  const gate = jobAt("gate");
  const n1 = jobAt("n-minus-1");
  const checkStep = gate.indexOf("name: Migration cũ bất biến");
  assert.ok(checkStep >= 0, "không thấy bước check-migrations trong job gate");
  assert.equal(expr(n1), expr(gate.slice(checkStep)));
  assert.match(n1, /fetch-depth: 0/);
  assert.match(n1, /timeout-minutes: \d+/);
  assert.match(n1, /postgres:16-alpine@sha256:/);
  assert.match(n1, /redis:7\.2-alpine@sha256:/);
  assert.match(n1, /node scripts\/n-minus-1\.mjs --detect-only/);
  assert.match(n1, /steps\.detect\.outputs\.run == 'true'/);
  assert.doesNotMatch(n1, /^\s+needs:/m, "chạy song song với gate, không needs");
  const needs = /needs: \[([^\]]*)\]/
    .exec(jobAt("quality"))[1]
    .split(",")
    .map((s) => s.trim());
  assert.ok(!needs.includes("n-minus-1"), "n-minus-1 không phải required check (D-115/T-163)");
  assert.ok(needs.includes("gate"), "job gate giữ tên");
});

/* ---------------------------------------------------- phát hiện migration ------------------------------------ */

test("migrationChanges: thêm/đổi/xoá; file không phải migration bỏ qua; rỗng → không đổi", () => {
  const base = new Map([
    [M("a", "Migration20260101000000"), "h1"],
    [M("a", "Migration20260102000000"), "h2"],
    [M("b", "Migration20260103000000"), "h3"],
    ["apps/backend/src/modules/a/migrations/.snapshot-a.json", "s1"],
  ]);
  const head = new Map([
    [M("a", "Migration20260101000000"), "h1"],
    [M("a", "Migration20260102000000"), "h2-sua"],
    [M("c", "Migration20260104000000"), "h4"],
    ["apps/backend/src/modules/a/migrations/.snapshot-a.json", "s2"],
  ]);
  const c = migrationChanges(base, head);
  assert.deepEqual(c, {
    added: [M("c", "Migration20260104000000")],
    changed: [M("a", "Migration20260102000000")],
    removed: [M("b", "Migration20260103000000")],
  });
  assert.equal(hasChanges(c), true);
  assert.equal(hasChanges(migrationChanges(base, new Map(base))), false);
  assert.equal(hasChanges(migrationChanges(new Map(), new Map())), false);
  // Chỉ snapshot đổi → không phải thay đổi schema.
  const snapOnly = new Map(base);
  snapOnly.set("apps/backend/src/modules/a/migrations/.snapshot-a.json", "khac");
  assert.equal(hasChanges(migrationChanges(base, snapOnly)), false);
});

test("planOverlay: chép vào module có ở N−1, xoá file bị xoá, module chỉ có ở HEAD thì bỏ qua", () => {
  assert.equal(moduleOf(M("checkout", "Migration1")), "checkout");
  const changes = {
    added: [M("checkout", "Migration20261027100000"), M("moi", "Migration20261027110000")],
    changed: [M("audit", "Migration20260101000000")],
    removed: [M("audit", "Migration20250101000000"), M("moi", "Migration20250101000000")],
  };
  const plan = planOverlay(changes, (m) => m !== "moi");
  assert.deepEqual(plan, {
    copy: [M("checkout", "Migration20261027100000"), M("audit", "Migration20260101000000")],
    remove: [M("audit", "Migration20250101000000")],
    newModules: ["moi"],
  });
  assert.deepEqual(
    planOverlay({ added: [], changed: [], removed: [] }, () => true),
    {
      copy: [],
      remove: [],
      newModules: [],
    },
  );
});

test("phát hiện migration trên repo git thật (blob hash cây làm việc, kể cả chưa commit)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "n1-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], {
      stdio: "pipe",
    });
  g("init", "-q", "-b", "main");
  const dir = join(root, "apps/backend/src/modules/a/migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Migration20260101000000.ts"), "export class Migration20260101000000 {}\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), lock({ medusa: { framework: "2.22.1" } }));
  g("add", ".");
  g("commit", "-q", "-m", "base");
  writeFileSync(join(dir, "Migration20260202000000.ts"), "export class Migration20260202000000 {}\n");
  g("add", ".");
  g("commit", "-q", "-m", "head");
  const logs = [];
  const log = { log: (m) => logs.push(m), error: (m) => logs.push(`E ${m}`) };
  const out = join(root, "gh-output");
  const opts = { base: "HEAD~1", detectOnly: true, keep: false, workdir: "", testPatterns: [] };
  const env1 = { GITHUB_OUTPUT: out };
  // Ref gốc HEAD~1 (khác HEAD): migration đã COMMIT ở HEAD là thay đổi → run=true. So nhầm với HEAD thì không thấy gì.
  assert.equal(await run(root, opts, detectDeps(root, env1, log)), 0);
  assert.equal(readFileSync(out, "utf8"), "run=true\n");
  assert.ok(logs.some((l) => l.includes("Migration20260202000000.ts")));
  // Ref gốc HEAD → không đổi → run=false.
  assert.equal(await run(root, { ...opts, base: "HEAD" }, detectDeps(root, env1, log)), 0);
  assert.equal(readFileSync(out, "utf8"), "run=true\nrun=false\n");
  // Thêm migration chưa commit → run=true.
  writeFileSync(join(dir, "Migration20260303000000.ts"), "export class Migration20260303000000 {}\n");
  assert.equal(await run(root, { ...opts, base: "HEAD" }, detectDeps(root, env1, log)), 0);
  assert.equal(readFileSync(out, "utf8"), "run=true\nrun=false\nrun=true\n");
  // Ref không có → 2, không ghi output.
  assert.equal(await run(root, { ...opts, base: "khong-co" }, detectDeps(root, env1, log)), 2);
  assert.equal(readFileSync(out, "utf8"), "run=true\nrun=false\nrun=true\n");
  // resolveSha thật trả commit của ĐÚNG ref gốc (cây N−1 được archive từ đó).
  const parent = execFileSync("git", ["-C", root, "rev-parse", "HEAD~1"], { encoding: "utf8" }).trim();
  assert.equal(realDeps(root).resolveSha("HEAD~1"), parent);
  assert.notEqual(realDeps(root).resolveSha("HEAD"), parent);
});

/** Deps thật (git qua check-migrations, ghi file thật); I/O nặng ném lỗi nếu bị gọi (detect-only không được chạm). */
function detectDeps(root, env, log) {
  const forbid = (name) => () => {
    throw new Error(`detect-only không được gọi ${name}`);
  };
  return {
    ...realDeps(root),
    env,
    log,
    proc: new EventEmitter(),
    allow: [], // repo giả không có migration của N1_ALLOW thật
    resolveSha: forbid("resolveSha"),
    mkdtemp: forbid("mkdtemp"),
    admin: forbid("admin"),
    exec: forbid("exec"),
  };
}

/* -------------------------------------------------------------- dựng lệnh ------------------------------------ */

test("pgBaseUrl: N1_PG_BASE_URL > DATABASE_URL (bỏ tên DB/query) > mặc định", () => {
  assert.equal(
    pgBaseUrl({ N1_PG_BASE_URL: "postgres://u:p@h:6543/", DATABASE_URL: "x" }),
    "postgres://u:p@h:6543",
  );
  assert.equal(
    pgBaseUrl({ DATABASE_URL: "postgres://xshop:xshop@localhost:5432/xshop?sslmode=disable" }),
    "postgres://xshop:xshop@localhost:5432",
  );
  assert.equal(pgBaseUrl({ DATABASE_URL: "postgres://db.local/xshop" }), "postgres://db.local");
  assert.equal(pgBaseUrl({}), DEFAULT_PG_BASE);
});

test("dbNames: tên an toàn, hai lần chạy đồng thời không trùng", () => {
  const a = dbNames();
  const b = dbNames();
  assert.match(a.head, SAFE_DB);
  assert.match(a.base, SAFE_DB);
  assert.notEqual(a.head, a.base);
  assert.notEqual(a.head, b.head);
  assert.deepEqual(dbNames("abc"), { head: "xshop_n1_abc_head", base: "xshop_n1_abc_base" });
  assert.throws(() => dbNames('x"; drop database xshop; --'), /không an toàn/);
  assert.throws(() => dbNames("ABC"), /không an toàn/);
});

test("buildSteps: lệnh cài/build/migrate/test, cwd và DATABASE_URL đúng cây/DB", () => {
  const s = buildSteps({
    root: "/repo",
    baseDir: "/tmp/w/base",
    pgBase: "postgres://u:p@h:5432",
    dbs: { head: "xshop_n1_x_head", base: "xshop_n1_x_base" },
    testPatterns: ["health", "refund"],
    resultsDir: "/tmp/w",
  });
  assert.deepEqual(
    [s.install.cmd, ...s.install.args],
    ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--filter", "@x-shop/backend..."],
  );
  assert.equal(s.install.cwd, "/tmp/w/base");
  assert.equal(s.buildHead.cwd, "/repo");
  assert.equal(s.buildBase.cwd, "/tmp/w/base");
  for (const [m, cwd, db] of [
    [s.migrateHead, "/repo/apps/backend", "xshop_n1_x_head"],
    [s.migrateBase, "/tmp/w/base/apps/backend", "xshop_n1_x_base"],
  ]) {
    assert.deepEqual(m.args.slice(0, 3), ["exec", "medusa", "db:migrate"]);
    assert.ok(m.args.includes("--execute-safe-links"), "không hỏi tương tác khi sync link");
    assert.ok(m.args.includes("--skip-scripts"));
    assert.equal(m.cwd, cwd);
    assert.equal(m.env.DATABASE_URL, `postgres://u:p@h:5432/${db}`);
    assert.equal(m.env.NODE_ENV, "development");
    assert.equal(m.env.REDIS_URL, "");
    assert.equal(m.quiet, true);
  }
  assert.deepEqual(s.test.args, [
    "run",
    "test:integration",
    "health",
    "refund",
    "--json",
    "--outputFile=/tmp/w/test.json",
  ]);
  assert.equal(s.test.results, "/tmp/w/test.json");
  assert.equal(s.test.cwd, "/tmp/w/base/apps/backend");
  assert.equal(s.test.env, undefined, "test N−1 dùng môi trường như lệnh test tích hợp thường");
  assert.deepEqual(
    buildSteps({ root: "/r", baseDir: "/b", pgBase: "p", dbs: { head: "h", base: "b" } }).test.args,
    ["run", "test:integration", "--json", "--outputFile=/b/test.json"],
  );
  // Chạy lại theo đường dẫn tuyệt đối (không phải regex — đường dẫn có `.`/`-`).
  const r = s.retest("control", "đối chứng", ["/tmp/w/base/apps/backend/integration-tests/http/a.spec.ts"]);
  assert.deepEqual(r.args, [
    "run",
    "test:integration",
    "--runTestsByPath",
    "/tmp/w/base/apps/backend/integration-tests/http/a.spec.ts",
    "--json",
    "--outputFile=/tmp/w/control.json",
  ]);
  assert.equal(r.results, "/tmp/w/control.json");
  assert.equal(r.cwd, "/tmp/w/base/apps/backend");
});

/* ---------------------------------------------------------------- so schema ---------------------------------- */

/** Đuôi dòng cột khi không có precision/identity/generated. */
const SUF = " precision -,-,- identity - generated - -";
const col = (table_name, column_name, extra = {}) => ({
  table_name,
  column_name,
  data_type: "text",
  udt_name: "text",
  character_maximum_length: null,
  is_nullable: "YES",
  column_default: null,
  ...extra,
});

test("schemaFromRows + diffSchemas: trùng, bảng chỉ ở HEAD, bảng chỉ ở N−1, cột/ràng buộc/index lệch", () => {
  const rows = {
    columns: [col("x", "id", { is_nullable: "NO" }), col("x", "note"), col("y", "id")],
    constraints: [{ table_name: "x", conname: "x_pkey", def: "PRIMARY KEY (id)" }],
    indexes: [{ table_name: "x", indexname: "IDX_x_note", indexdef: "CREATE INDEX ... (note)" }],
  };
  const a = schemaFromRows(rows);
  assert.deepEqual(diffSchemas(a, schemaFromRows(rows)), { onlyHead: [], onlyBase: [], mismatched: [] });
  assert.deepEqual(a.get("x"), [
    "column id text/text not null default -" + SUF,
    "column note text/text null default -" + SUF,
    "constraint x_pkey PRIMARY KEY (id)",
    "index IDX_x_note CREATE INDEX ... (note)",
  ]);
  const head = schemaFromRows({
    ...rows,
    columns: [
      ...rows.columns,
      col("x", "shipping", { data_type: "jsonb", udt_name: "jsonb" }),
      col("moi", "id"),
    ],
  });
  const base = schemaFromRows({ ...rows, columns: [...rows.columns, col("cu", "id")], indexes: [] });
  const d = diffSchemas(head, base);
  assert.deepEqual(d.onlyHead, ["moi"]);
  assert.deepEqual(d.onlyBase, ["cu"]);
  assert.deepEqual(d.mismatched, [
    {
      table: "x",
      onlyHead: [
        "column shipping jsonb/jsonb null default -" + SUF,
        "index IDX_x_note CREATE INDEX ... (note)",
      ],
      onlyBase: [],
    },
  ]);
  // NOT NULL khác nhau cũng là lệch.
  const nn = diffSchemas(
    schemaFromRows({ columns: [col("x", "a", { is_nullable: "NO" })] }),
    schemaFromRows({ columns: [col("x", "a")] }),
  );
  assert.equal(nn.mismatched.length, 1);
});

test("normalizeDefault: ULID literal sinh lúc migrate (workflow_execution.run_id) không tính là lệch; DEFAULT khác vẫn so", () => {
  assert.equal(normalizeDefault("'01M5ZTSN6XEE7XCYPMS5PHQBA4'::text"), "'<ulid>'::text");
  assert.equal(normalizeDefault(null), "-");
  assert.equal(normalizeDefault(undefined), "-");
  assert.equal(normalizeDefault("0"), "0");
  assert.equal(normalizeDefault("'pending'::text"), "'pending'::text");
  // 26 ký tự nhưng có chữ thường/ký tự ngoài Crockford (I, L, O, U) → không phải ULID, giữ nguyên.
  assert.equal(normalizeDefault("'01m5ztsn6xee7xcyp ms5phqba4'"), "'01m5ztsn6xee7xcyp ms5phqba4'");
  assert.equal(normalizeDefault("'01M5ZTSN6XEE7XCYPMS5PHQBAI'::text"), "'01M5ZTSN6XEE7XCYPMS5PHQBAI'::text");
  const run1 = schemaFromRows({
    columns: [col("workflow_execution", "run_id", { column_default: "'01M5ZTSN6XEE7XCYPMS5PHQBA4'::text" })],
  });
  const run2 = schemaFromRows({
    columns: [col("workflow_execution", "run_id", { column_default: "'01M5ZTSXGRRA2RPW9JGV9T5GV1'::text" })],
  });
  assert.deepEqual(diffSchemas(run1, run2).mismatched, []);
  const other = schemaFromRows({ columns: [col("x", "s", { column_default: "'a'::text" })] });
  const other2 = schemaFromRows({ columns: [col("x", "s", { column_default: "'b'::text" })] });
  assert.equal(diffSchemas(other, other2).mismatched.length, 1);
});

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_400), "59s");
  assert.equal(formatDuration(60_000), "1m00s");
  assert.equal(formatDuration(1_234_567), "20m35s");
});

/* ------------------------------------------------------------ quy trình + dọn ---------------------------------- */

const SAME = new Map([["x", ["column id text/text not null default -"]]]);
const CHANGES_BASE = new Map([[M("checkout", "Migration20260101000000"), "h1"]]);
const CHANGES_HEAD = new Map([
  [M("checkout", "Migration20260101000000"), "h1"],
  [M("checkout", "Migration20261027100000"), "h2"],
]);

/** Deps giả ghi lại sự kiện theo thứ tự. `codes[id]` = mã thoát của bước; `onExec[id]` = hàm thay exec. */
function fake({
  base = CHANGES_BASE,
  head = CHANGES_HEAD,
  refOk = true,
  codes = {},
  onExec = {},
  schemas = { head: SAME, base: SAME },
  adminFail = () => false,
  env = {},
  results = {},
  allow = [],
  expectRef = "origin/master",
} = {}) {
  const events = [];
  const files = new Map();
  const proc = new EventEmitter();
  proc.exitCalls = [];
  proc.exit = (c) => proc.exitCalls.push(c);
  const logs = [];
  let t = 0;
  const deps = {
    env,
    proc,
    log: { log: (m) => logs.push(m), error: (m) => logs.push(`E ${m}`) },
    now: () => (t += 1000),
    hex: () => "abc123",
    allow,
    // Mọi truy vấn git phải dùng ĐÚNG ref gốc của lần chạy (không HEAD) — đột biến resolveSha/baseMigrations("HEAD") chết.
    refExists: (ref) => (assert.equal(ref, expectRef), refOk),
    resolveSha: (ref) => (assert.equal(ref, expectRef), "0123456789abcdef0123"),
    baseMigrations: (ref) => (assert.equal(ref, expectRef), base),
    headMigrations: () => head,
    mkdtemp: (parent) => {
      events.push(`mkdtemp ${parent}`);
      return `${parent}/xshop-n1-T`;
    },
    mkdir: () => undefined,
    rm: (d) => events.push(`rm ${d}`),
    extract: async (sha, dir) => events.push(`extract ${sha} ${dir}`),
    exists: (p) => p.includes("/checkout/"),
    // FS ảo: file của cây HEAD (/repo/…) luôn có; file khác chỉ có khi đã ghi.
    readFile: (p) => (files.has(p) ? files.get(p) : p.startsWith("/repo/") ? `HEAD ${p}` : null),
    writeFile: (p, d) => {
      files.set(p, d);
      events.push(`write ${p}`);
    },
    unlink: (p) => {
      files.delete(p);
      events.push(`unlink ${p}`);
    },
    admin: async (_pg, sql) => {
      if (adminFail(sql)) throw new Error(`admin lỗi: ${sql}`);
      events.push(sql.replace(/ WITH \(FORCE\)$/, ""));
    },
    readSchema: async (_pg, db) => (db.endsWith("_head") ? schemas.head : schemas.base),
    exec: async (step) => {
      events.push(`exec ${step.id}`);
      // `results[id]` = suite đỏ → báo cáo `jest --json` giả ở step.results (chuỗi "rác" = báo cáo hỏng). Khoá
      // `confirm` áp cho mọi lần xác nhận (confirm1, confirm2…) trừ khi có khoá riêng.
      const key = (o) => (o[step.id] !== undefined ? step.id : step.id.replace(/^confirm\d+$/, "confirm"));
      const r = results[key(results)];
      if (step.results && r !== undefined)
        files.set(
          step.results,
          typeof r === "string"
            ? r
            : JSON.stringify({
                testResults: [
                  // Phần tử: tên suite (suite đỏ không có ca → lỗi nạp) hoặc { name, tests: [[describe…, ca]] }.
                  ...r.map((s) =>
                    typeof s === "string"
                      ? { name: s, status: "failed" }
                      : {
                          name: s.name,
                          status: "failed",
                          assertionResults: [
                            ...s.tests.map((path) => ({
                              ancestorTitles: ["", ...path.slice(0, -1)],
                              title: path.at(-1),
                              status: "failed",
                            })),
                            { ancestorTitles: [""], title: "ca xanh", status: "passed" },
                          ],
                        },
                  ),
                  { name: "/w/xshop-n1-T/base/apps/backend/ok.spec.ts", status: "passed" },
                ],
              }),
        );
      if (onExec[step.id]) return onExec[step.id](step);
      return { code: codes[key(codes)] ?? 0 };
    },
    killCurrent: async (sig) => events.push(`kill ${sig}`),
    appendFile: (f, s) => events.push(`append ${f} ${s.split("\n")[0]}`),
  };
  return { deps, events, logs, proc, files };
}
const OPTS = { base: "origin/master", detectOnly: false, keep: false, workdir: "/w", testPatterns: [] };

test("run: không có migration đổi → 0 ngay, không tạo thư mục/DB, không chạy lệnh, có log", async () => {
  const f = fake({ head: CHANGES_BASE });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.deepEqual(f.events, []);
  assert.ok(f.logs.some((l) => /không có migration .*bỏ qua/.test(l)));
});

test("run: --detect-only ghi run=true|false vào GITHUB_OUTPUT, không chạy gì nặng", async () => {
  const yes = fake({ env: { GITHUB_OUTPUT: "/o" } });
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, yes.deps), 0);
  assert.deepEqual(yes.events, ["append /o run=true"]);
  const no = fake({ head: CHANGES_BASE, env: { GITHUB_OUTPUT: "/o" } });
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, no.deps), 0);
  assert.deepEqual(no.events, ["append /o run=false"]);
});

test("run: ref gốc không có → 2, không làm gì", async () => {
  const f = fake({ refOk: false });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.deepEqual(f.events, []);
  assert.ok(f.logs.some((l) => l.startsWith("E ") && l.includes("không có trong repo")));
});

test("run: đường xanh — đúng thứ tự, DB xoá TRƯỚC test, thư mục tạm xoá cuối, bảng thời gian vào step summary", async () => {
  const f = fake({ env: { GITHUB_STEP_SUMMARY: "/sum" } });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.deepEqual(f.events, [
    "mkdtemp /w",
    "extract 0123456789abcdef0123 /w/xshop-n1-T/base",
    "exec install",
    `write /w/xshop-n1-T/base/${M("checkout", "Migration20261027100000")}`,
    "exec build-head",
    "exec build-base",
    'CREATE DATABASE "xshop_n1_abc123_head"',
    'CREATE DATABASE "xshop_n1_abc123_base"',
    "exec migrate-head",
    "exec migrate-base",
    'DROP DATABASE IF EXISTS "xshop_n1_abc123_head"',
    'DROP DATABASE IF EXISTS "xshop_n1_abc123_base"',
    "exec test",
    "rm /w/xshop-n1-T",
    "append /sum ### n-minus-1 (ref gốc origin/master) — mã 0",
  ]);
  assert.ok(f.logs.some((l) => l.includes("ĐẠT")));
  assert.ok(f.logs.some((l) => /\| tổng \| \d+s \|/.test(l)));
  assert.equal(f.proc.listenerCount("SIGINT"), 0, "gỡ handler tín hiệu");
  assert.equal(f.proc.listenerCount("SIGTERM"), 0);
});

const SUITE_A = "/w/xshop-n1-T/base/apps/backend/integration-tests/http/a.spec.ts";
const SUITE_B = "/w/xshop-n1-T/base/apps/backend/integration-tests/http/b.spec.ts";
const COPIED = `/w/xshop-n1-T/base/${M("checkout", "Migration20261027100000")}`;

test("run: suite đỏ trên schema N, xanh trên N−1 (đối chứng) → 1; chạy lại đúng suite đỏ; gỡ phủ TRƯỚC đối chứng", async () => {
  const f = fake({
    codes: { test: 1, confirm: 1 },
    results: { test: [SUITE_A], confirm: [SUITE_A], control: [] },
  });
  let controlSaw;
  f.deps.exec = ((orig) => async (step) => {
    if (step.id === "control") controlSaw = f.files.has(COPIED);
    return orig(step);
  })(f.deps.exec);
  assert.equal(await run("/repo", OPTS, f.deps), 1);
  const i = (e) => f.events.indexOf(e);
  assert.ok(i("exec test") < i("exec confirm1") && i("exec confirm1") < i("exec confirm2"));
  assert.ok(i("exec confirm2") < i(`unlink ${COPIED}`));
  assert.ok(i(`unlink ${COPIED}`) < i("exec control"));
  assert.equal(controlSaw, false, "đối chứng chạy khi migration HEAD đã gỡ khỏi cây N−1");
  assert.equal(f.events.at(-1), "rm /w/xshop-n1-T");
  assert.ok(
    f.logs.some((l) => l.includes("KHÔNG TƯƠNG THÍCH: apps/backend/integration-tests/http/a.spec.ts")),
  );
  assert.ok(f.logs.some((l) => l.startsWith("E ") && l.includes("không tương thích ngược")));
});

test("run: suite đỏ cả trên schema N−1 của chính nó → 2 (không quy cho migration)", async () => {
  const f = fake({
    codes: { test: 1, confirm: 1, control: 1 },
    results: { test: [SUITE_A], confirm: [SUITE_A], control: [SUITE_A] },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(f.logs.some((l) => l.includes("N−1 TỰ ĐỎ")));
  assert.ok(!f.logs.some((l) => l.includes("không tương thích ngược")));
});

test("run: suite đỏ lần đầu, xanh ở MỌI lần xác nhận + đối chứng → CHẬP CHỜN, mã 2 (D-124), có annotation trên CI", async () => {
  const f = fake({
    env: { GITHUB_ACTIONS: "true" },
    codes: { test: 1 },
    results: { test: [SUITE_A], confirm: [], control: [] },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(f.logs.some((l) => l.includes("CHẬP CHỜN")));
  assert.ok(f.events.includes("exec confirm1") && f.events.includes("exec confirm2"), "xác nhận ≥ 2 lần");
  assert.ok(
    f.logs.some((l) => l.startsWith("::error title=n-minus-1 (flaky)::") && l.includes("chạy lại job")),
  );
});

test("run: mã test ≠ 0 mà báo cáo jest thiếu/hỏng/không nêu suite đỏ → 2", async () => {
  for (const results of [{}, { test: "{rác" }, { test: [] }]) {
    const f = fake({ codes: { test: 1 }, results });
    assert.equal(await run("/repo", OPTS, f.deps), 2, JSON.stringify(results));
    assert.ok(!f.events.includes("exec confirm1"));
  }
  const g = fake({ codes: { test: 1, confirm: 1 }, results: { test: [SUITE_A], control: "{rác" } });
  assert.equal(await run("/repo", OPTS, g.deps), 2);
});

test("classifyCases: phân loại THEO CA; lỗi cả suite ở một lần chạy = mọi ca của suite đỏ ở lần đó", () => {
  const m = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));
  const remaining = m({ [SUITE_A]: ["t1", "t2", "t3"], [SUITE_B]: ["u1"] });
  const c = classifyCases(
    remaining,
    [m({ [SUITE_A]: ["t1", "t2"] }), m({ [SUITE_A]: ["t1"] })],
    m({ [SUITE_A]: ["t2"] }),
  );
  assert.deepEqual(c, {
    incompatible: [{ suite: SUITE_A, test: "t1" }],
    baseRed: [{ suite: SUITE_A, test: "t2" }],
    flaky: [
      { suite: SUITE_A, test: "t3" },
      { suite: SUITE_B, test: "u1" },
    ],
    code: 1,
  });
  // Đỏ chỉ ở MỘT lần xác nhận vẫn là không tương thích (xanh ở đối chứng).
  assert.equal(classifyCases(m({ [SUITE_A]: ["t"] }), [m({}), m({ [SUITE_A]: ["t"] })], m({})).code, 1);
  // Suite lỗi nạp ở đối chứng → mọi ca còn lại của suite: N−1 tự đỏ.
  const e = classifyCases(
    m({ [SUITE_A]: ["t"] }),
    [m({ [SUITE_A]: ["t"] })],
    m({ [SUITE_A]: [SUITE_ERROR] }),
  );
  assert.deepEqual([e.baseRed.length, e.code], [1, 2]);
  // Suite lỗi nạp ở xác nhận, đối chứng xanh → không tương thích.
  assert.equal(classifyCases(m({ [SUITE_A]: ["t"] }), [m({ [SUITE_A]: [SUITE_ERROR] })], m({})).code, 1);
  assert.equal(classifyCases(m({ [SUITE_A]: ["t"] }), [m({})], m({})).code, 2, "chỉ chập chờn → 2");
  assert.equal(classifyCases(new Map(), [], new Map()).code, 0);
});

const R_CASE_ALLOW = {
  ...{ suite: "apps/backend/integration-tests/http/a.spec.ts" },
  test: "nhóm › hàng rào so bằng",
};
const rAllow = {
  ...R_CASE_ALLOW,
  migration: M("checkout", "Migration20261027100000"),
  reason: "hàng rào so bằng schema với hằng của bản N−1",
};
const rs = (...tests) => ({ name: SUITE_A, tests: tests.map((t) => t.split(" › ")) });

test("R1: ca đã miễn + ca khác chỉ chập chờn trong cùng suite → không quy ca miễn cho migration; CHẬP CHỜN, mã 2", async () => {
  const f = fake({
    allow: [rAllow],
    codes: { test: 1, confirm: 1 },
    results: {
      test: [rs("nhóm › hàng rào so bằng", "nhóm › ca timeout")],
      confirm: [rs("nhóm › hàng rào so bằng")], // ca miễn vẫn đỏ ở xác nhận, ca timeout xanh
      control: [],
    },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(!f.logs.some((l) => l.includes("KHÔNG TƯƠNG THÍCH")));
  assert.ok(
    f.logs.some((l) =>
      l.includes('CHẬP CHỜN: apps/backend/integration-tests/http/a.spec.ts › "nhóm › ca timeout"'),
    ),
  );
  assert.ok(f.logs.some((l) => l.includes("MIỄN (N1_ALLOW)")));
});

test("R2: ca hỏng sẵn ở N−1 + ca không tương thích thật cùng suite → mã 1, mỗi ca đúng nhãn", async () => {
  const f = fake({
    codes: { test: 1, confirm: 1, control: 1 },
    results: {
      test: [rs("T1 hỏng sẵn", "T2 ghi order_finance")],
      confirm: [rs("T1 hỏng sẵn", "T2 ghi order_finance")],
      control: [rs("T1 hỏng sẵn")],
    },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 1);
  assert.ok(
    f.logs.some((l) =>
      l.includes('KHÔNG TƯƠNG THÍCH: apps/backend/integration-tests/http/a.spec.ts › "T2 ghi order_finance"'),
    ),
  );
  assert.ok(
    f.logs.some((l) =>
      l.includes('N−1 TỰ ĐỎ: apps/backend/integration-tests/http/a.spec.ts › "T1 hỏng sẵn"'),
    ),
  );
});

test("R3: đỏ một lần trên N, xanh ở 2 lần xác nhận và đối chứng → mã 2 (không phải 0)", async () => {
  const f = fake({
    codes: { test: 1 },
    results: { test: [rs("T2 ghi order_finance")], confirm: [], control: [] },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.equal(f.events.filter((e) => /^exec confirm\d$/.test(e)).length, CONFIRM_RUNS);
  assert.ok(CONFIRM_RUNS >= 2);
});

test("annotation CI theo nguyên nhân: không tương thích, N−1 tự đỏ, schema lệch, ref thiếu", async () => {
  const env = { GITHUB_ACTIONS: "true" };
  const ann = (f, cause) => f.logs.some((l) => l.startsWith(`::error title=n-minus-1 (${cause})::`));
  const r2 = fake({
    env,
    codes: { test: 1 },
    results: { test: [rs("T1", "T2")], confirm: [rs("T1", "T2")], control: [rs("T1")] },
  });
  await run("/repo", OPTS, r2.deps);
  assert.ok(ann(r2, "incompatible") && ann(r2, "base-red"));
  assert.ok(r2.logs.some((l) => l.includes("merge master")));
  const sm = fake({ env, schemas: { head: SAME, base: new Map([["x", ["khác"]]]) } });
  assert.equal(await run("/repo", OPTS, sm.deps), 2);
  assert.ok(ann(sm, "schema-mismatch") && sm.logs.some((l) => l.includes("nâng @medusajs")));
  const rf = fake({ env, refOk: false });
  assert.equal(await run("/repo", OPTS, rf.deps), 2);
  assert.ok(ann(rf, "ref-missing"));
  // Ngoài CI: không in `::error::`.
  const local = fake({ refOk: false });
  await run("/repo", OPTS, local.deps);
  assert.ok(!local.logs.some((l) => l.startsWith("::error")));
});

test("DB không phải cục bộ/CI → 2 trước khi tạo gì; --allow-remote-db mở", async () => {
  assert.equal(isLocalDbUrl("postgres://u:p@localhost:5432/x"), true);
  assert.equal(isLocalDbUrl("postgres://u:p@127.0.0.1/x"), true);
  assert.equal(isLocalDbUrl("postgres://u:p@[::1]:5432/x"), true);
  assert.equal(isLocalDbUrl("postgres://u:p@postgres:5432/x"), true);
  assert.equal(isLocalDbUrl("postgres://u:p@db.prod.example.com/x"), false);
  assert.equal(isLocalDbUrl("không phải url"), false);
  const remote = { DATABASE_URL: "postgres://u:p@db.prod.example.com:5432/xshop" };
  const f = fake({ env: remote });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(!f.events.some((e) => e.startsWith("mkdtemp") || e.startsWith("CREATE")));
  assert.ok(f.logs.some((l) => /\((?:db\.prod\.example\.com(?:, )?)+\)/.test(l)));
  const g = fake({ env: { ...remote, N1_PG_BASE_URL: "postgres://u:p@localhost:5432" } });
  assert.equal(await run("/repo", OPTS, g.deps), 2, "DATABASE_URL của test vẫn là DB lạ");
  const ok = fake({ env: remote });
  assert.equal(await run("/repo", { ...OPTS, allowRemoteDb: true }, ok.deps), 0);
  assert.equal(parseArgs(["--allow-remote-db"], {}).allowRemoteDb, true);
  assert.equal(parseArgs([], {}).allowRemoteDb, false);
});

test("ref gốc: fake từ chối ref khác ref của lần chạy (khoá đột biến dùng HEAD)", async () => {
  const f = fake({ expectRef: "origin/dev" });
  assert.equal(await run("/repo", { ...OPTS, base: "origin/dev" }, f.deps), 0);
  const g = fake({ expectRef: "origin/dev" });
  await assert.rejects(() => run("/repo", OPTS, g.deps));
});

test("failedSuites: đọc báo cáo jest --json (chuỗi/Buffer), hỏng → null", () => {
  const j = {
    testResults: [
      { name: "/b.spec.ts", status: "failed" },
      { name: "/a.spec.ts", status: "failed" },
      { name: "/c.spec.ts", status: "passed" },
    ],
  };
  assert.deepEqual(failedSuites(JSON.stringify(j)), ["/a.spec.ts", "/b.spec.ts"]);
  assert.deepEqual(failedSuites(Buffer.from(JSON.stringify(j))), ["/a.spec.ts", "/b.spec.ts"]);
  assert.deepEqual(failedSuites(j), ["/a.spec.ts", "/b.spec.ts"]);
  assert.equal(failedSuites(null), null);
  assert.equal(failedSuites("{"), null);
  assert.equal(failedSuites("{}"), null);
  assert.deepEqual(failedSuites({ testResults: [] }), []);
});

test("run: cài phụ thuộc lỗi → 2, không tạo DB, vẫn xoá thư mục tạm", async () => {
  const f = fake({ codes: { install: 1 } });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(!f.events.some((e) => e.startsWith("CREATE")));
  assert.equal(f.events.at(-1), "rm /w/xshop-n1-T");
});

test("run: db:migrate HEAD lỗi → 2, xoá cả hai DB đã tạo và thư mục, không chạy test", async () => {
  const f = fake({ codes: { "migrate-head": 1 } });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(!f.events.includes("exec test"));
  assert.deepEqual(f.events.slice(-3), [
    'DROP DATABASE IF EXISTS "xshop_n1_abc123_head"',
    'DROP DATABASE IF EXISTS "xshop_n1_abc123_base"',
    "rm /w/xshop-n1-T",
  ]);
});

test("run: tạo DB thứ hai lỗi → chỉ xoá DB đã tạo (không DROP DB không phải của mình)", async () => {
  const f = fake({ adminFail: (sql) => sql.startsWith('CREATE DATABASE "xshop_n1_abc123_base"') });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  const drops = f.events.filter((e) => e.startsWith("DROP"));
  assert.deepEqual(drops, ['DROP DATABASE IF EXISTS "xshop_n1_abc123_head"']);
});

test("run: xoá DB lỗi → log nhắc xoá tay, vẫn xoá thư mục, mã giữ nguyên", async () => {
  const f = fake({ adminFail: (sql) => sql.startsWith("DROP") });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.ok(f.logs.some((l) => l.includes("xoá tay")));
  assert.equal(f.events.at(-1), "rm /w/xshop-n1-T");
});

test("run: overlay không tái tạo schema N → 2, không chạy test, in bảng lệch", async () => {
  const f = fake({
    schemas: { head: SAME, base: new Map([["x", ["column id text/text null default -"]]]) },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 2);
  assert.ok(!f.events.includes("exec test"));
  assert.ok(f.logs.some((l) => l.includes("x lệch:")));
  assert.ok(f.events.includes('DROP DATABASE IF EXISTS "xshop_n1_abc123_base"'));
});

test("run: bảng chỉ có ở HEAD (module/link mới) → chỉ log, vẫn chạy test", async () => {
  const f = fake({ schemas: { head: new Map([...SAME, ["x_moi", ["column id"]]]), base: SAME } });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.ok(f.logs.some((l) => l.includes("chỉ có ở schema HEAD") && l.includes("x_moi")));
});

test("run: --keep giữ thư mục tạm nhưng vẫn xoá DB", async () => {
  const f = fake();
  assert.equal(await run("/repo", { ...OPTS, keep: true }, f.deps), 0);
  assert.ok(!f.events.some((e) => e.startsWith("rm ")));
  assert.equal(f.events.filter((e) => e.startsWith("DROP")).length, 2);
});

for (const [sig, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
]) {
  test(`run: ${sig} giữa lúc test → chuyển tín hiệu cho tiến trình con, dọn MỘT lần, thoát ${code} (runner thoát 0 không tính xanh)`, async () => {
    let release;
    const f = fake({
      onExec: {
        test: () =>
          new Promise((resolve) => {
            release = resolve;
            setImmediate(() => f.proc.emit(sig, sig));
          }),
      },
    });
    f.deps.killCurrent = async (s) => {
      f.events.push(`kill ${s}`);
      release({ code: 0 }); // runner của Medusa bắt SIGTERM rồi thoát 0
    };
    assert.equal(await run("/repo", OPTS, f.deps), code);
    await new Promise((r) => setImmediate(r));
    assert.ok(f.events.includes(`kill ${sig}`));
    assert.equal(
      f.events.filter((e) => e.startsWith("rm ")).length,
      1,
      "dọn một lần dù handler và finally cùng gọi",
    );
    assert.deepEqual(f.proc.exitCalls, [code]);
    assert.ok(!f.logs.some((l) => l.includes("ĐẠT")));
  });
}

test("run: SIGTERM giữa db:migrate → DB đã tạo bị xoá đúng một lần, không chạy bước sau", async () => {
  const f = fake({
    onExec: {
      "migrate-head": () => {
        f.proc.emit("SIGTERM", "SIGTERM");
        return { code: 0 };
      },
    },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 143);
  await new Promise((r) => setImmediate(r));
  assert.ok(!f.events.includes("exec migrate-base"));
  assert.ok(!f.events.includes("exec test"));
  assert.equal(f.events.filter((e) => e === 'DROP DATABASE IF EXISTS "xshop_n1_abc123_head"').length, 1);
  assert.equal(f.events.filter((e) => e.startsWith("rm ")).length, 1);
});

test("run: hai lần chạy đồng thời → DB và thư mục tạm riêng, không xoá của nhau", async () => {
  const a = fake();
  const b = fake();
  a.deps.hex = () => "aaa111";
  b.deps.hex = () => "bbb222";
  a.deps.mkdtemp = (p) => (a.events.push("mkdtemp"), `${p}/A`);
  b.deps.mkdtemp = (p) => (b.events.push("mkdtemp"), `${p}/B`);
  const [ra, rb] = await Promise.all([run("/repo", OPTS, a.deps), run("/repo", OPTS, b.deps)]);
  assert.deepEqual([ra, rb], [0, 0]);
  assert.ok(a.events.every((e) => !e.includes("bbb222") && e !== "rm /w/B"));
  assert.ok(b.events.every((e) => !e.includes("aaa111") && e !== "rm /w/A"));
  assert.ok(a.events.includes("rm /w/A") && b.events.includes("rm /w/B"));
});
/* --------------------------------------------------------- danh sách miễn (D-123) ------------------------------ */

const CHECKOUT_MIG = M("checkout", "Migration20261027100000");
const ALLOW_A = {
  suite: "apps/backend/integration-tests/http/a.spec.ts",
  test: "nhóm › hàng rào so bằng",
  migration: CHECKOUT_MIG,
  reason: "hàng rào so bằng schema với hằng của bản N−1, migration nới CHECK",
};
const caseA = ["nhóm", "hàng rào so bằng"];

test("caseName + failedDetails: tên ca như Jest in (bỏ describe rỗng); suite đỏ không có ca đỏ = lỗi nạp", () => {
  assert.equal(caseName({ ancestorTitles: ["", "a", "b"], title: "c" }), "a › b › c");
  assert.equal(caseName({ title: "c" }), "c");
  const j = {
    testResults: [
      {
        name: "/s/b.spec.ts",
        status: "failed",
        assertionResults: [
          { ancestorTitles: ["", "x"], title: "đỏ", status: "failed" },
          { ancestorTitles: ["", "x"], title: "xanh", status: "passed" },
        ],
      },
      { name: "/s/a.spec.ts", status: "failed", assertionResults: [] },
      {
        name: "/s/c.spec.ts",
        status: "failed",
        testExecError: { message: "afterAll" },
        assertionResults: [{ ancestorTitles: [], title: "t", status: "failed" }],
      },
      { name: "/s/d.spec.ts", status: "passed", assertionResults: [] },
    ],
  };
  assert.deepEqual(failedDetails(JSON.stringify(j)), [
    { name: "/s/a.spec.ts", failedTests: [], execError: true },
    { name: "/s/b.spec.ts", failedTests: ["x › đỏ"], execError: false },
    { name: "/s/c.spec.ts", failedTests: ["t"], execError: true },
  ]);
  assert.equal(failedDetails("{"), null);
  assert.equal(failedDetails(null), null);
});

test("N1_ALLOW thật hợp lệ với migration của repo; tên ca có trong suite (chống gõ sai)", () => {
  const root = join(here, "..");
  assert.deepEqual(validateAllow(N1_ALLOW, listMigrations(root)), []);
  assert.ok(N1_ALLOW.some((e) => e.migration.endsWith("/Migration20261027160101.ts")));
  for (const e of N1_ALLOW) {
    const src = readFileSync(join(root, e.suite), "utf8");
    for (const part of e.test.split(" › "))
      assert.ok(src.includes(JSON.stringify(part)), `${e.suite}: thiếu "${part}"`);
  }
});

test("validateAllow: thiếu trường, lý do ngắn, migration không phải file migration / không còn, trùng mục", () => {
  const have = [CHECKOUT_MIG];
  assert.deepEqual(validateAllow([ALLOW_A], have), []);
  assert.deepEqual(validateAllow([], []), []);
  const errs = (e) => validateAllow([e], have).join("\n");
  assert.match(errs({ ...ALLOW_A, test: "" }), /thiếu test/);
  assert.match(errs({ ...ALLOW_A, suite: undefined }), /thiếu suite/);
  assert.match(errs({ ...ALLOW_A, reason: "ngắn" }), /lý do < 20/);
  assert.match(errs({ ...ALLOW_A, migration: "Migration20261027100000" }), /đường dẫn file migration/);
  assert.match(
    errs({ ...ALLOW_A, migration: M("checkout", "Migration20990101000000") }),
    /không còn trong cây HEAD/,
  );
  assert.match(validateAllow([ALLOW_A, { ...ALLOW_A }], have).join("\n"), /trùng/);
});

test("applyAllow: miễn THEO CA khớp chính xác mục có hiệu lực; ca khác vẫn còn; lỗi cả suite không miễn; mục không dùng được nhắc", () => {
  const base = "/w/b";
  const abs = (s) => `${base}/${s}`;
  const m = (obj) => new Map(Object.entries(obj).map(([k, v]) => [abs(k), new Set(v)]));
  const on = new Set([CHECKOUT_MIG]);
  const left = (r) => Object.fromEntries([...r.remaining].map(([k, v]) => [k, [...v]]));
  // Khớp hết → miễn, không còn gì.
  let r = applyAllow(m({ [ALLOW_A.suite]: [ALLOW_A.test] }), [ALLOW_A], on, base);
  assert.deepEqual(left(r), {});
  assert.deepEqual(r.allowed, [{ suite: ALLOW_A.suite, test: ALLOW_A.test }]);
  assert.deepEqual(r.unused, []);
  // Thêm một ca đỏ khác → chỉ ca khác còn lại (ca miễn không bị đem phân loại).
  r = applyAllow(m({ [ALLOW_A.suite]: [ALLOW_A.test, "nhóm › ca khác"] }), [ALLOW_A], on, base);
  assert.deepEqual(left(r), { [abs(ALLOW_A.suite)]: ["nhóm › ca khác"] });
  assert.deepEqual(r.unused, []);
  // Migration của mục không nằm trong phần phủ → mục không hiệu lực, không nhắc.
  r = applyAllow(m({ [ALLOW_A.suite]: [ALLOW_A.test] }), [ALLOW_A], new Set(), base);
  assert.deepEqual([left(r), r.allowed, r.unused], [{ [abs(ALLOW_A.suite)]: [ALLOW_A.test] }, [], []]);
  // Cùng tên ca ở suite khác → không khớp; lỗi cả suite không bao giờ được miễn.
  r = applyAllow(m({ "apps/backend/integration-tests/http/z.spec.ts": [ALLOW_A.test] }), [ALLOW_A], on, base);
  assert.equal(r.remaining.size, 1);
  r = applyAllow(m({ [ALLOW_A.suite]: [SUITE_ERROR] }), [{ ...ALLOW_A, test: SUITE_ERROR }], on, base);
  assert.equal(r.remaining.size, 1);
  // Tên phải khớp chính xác (không regex/tiền tố).
  r = applyAllow(m({ [ALLOW_A.suite]: [`${ALLOW_A.test} `] }), [ALLOW_A], on, base);
  assert.equal(r.remaining.size, 1);
  // Không có ca đỏ, mục có hiệu lực → nhắc.
  assert.deepEqual(applyAllow(new Map(), [ALLOW_A], on, base).unused, [ALLOW_A]);
});

test("failedCases: suite lỗi nạp thêm SUITE_ERROR; null → null", () => {
  assert.equal(failedCases(null), null);
  const c = failedCases([
    { name: "/a", failedTests: ["x"], execError: false },
    { name: "/b", failedTests: [], execError: true },
  ]);
  assert.deepEqual([...c.get("/a")], ["x"]);
  assert.deepEqual([...c.get("/b")], [SUITE_ERROR]);
});

const SUITE_ALLOW = `/w/xshop-n1-T/base/${ALLOW_A.suite}`;

test("run: suite chỉ đỏ ở ca đã miễn → 0, không chạy lại/đối chứng, log MIỄN", async () => {
  const f = fake({
    allow: [ALLOW_A],
    codes: { test: 1 },
    results: { test: [{ name: SUITE_ALLOW, tests: [caseA] }] },
  });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.ok(!f.events.includes("exec confirm") && !f.events.includes("exec control"));
  assert.ok(f.logs.some((l) => l.includes(`MIỄN (N1_ALLOW): ${ALLOW_A.suite}`)));
  assert.equal(f.events.at(-1), "rm /w/xshop-n1-T");
});

test("run: một suite được miễn, suite khác đỏ thật → chỉ chạy lại suite chưa miễn, mã 1", async () => {
  const f = fake({
    allow: [ALLOW_A],
    codes: { test: 1, confirm: 1 },
    results: {
      test: [{ name: SUITE_ALLOW, tests: [caseA] }, SUITE_B],
      confirm: [SUITE_B],
      control: [],
    },
  });
  let retested;
  f.deps.exec = ((orig) => async (step) => {
    if (step.id === "confirm1") retested = step.args.filter((a) => a.startsWith("/w/"));
    return orig(step);
  })(f.deps.exec);
  assert.equal(await run("/repo", OPTS, f.deps), 1);
  assert.deepEqual(retested, [SUITE_B]);
});

test("run: lần chạy có phủ migration của mục mà test xanh → NHẮC; mục không hiệu lực thì im", async () => {
  const green = fake({ allow: [ALLOW_A] });
  assert.equal(await run("/repo", OPTS, green.deps), 0);
  assert.ok(green.logs.some((l) => l.includes("NHẮC: mục N1_ALLOW")));
  const other = {
    ...ALLOW_A,
    migration: M("checkout", "Migration20260101000000"),
  };
  const quiet = fake({ allow: [other] });
  assert.equal(await run("/repo", OPTS, quiet.deps), 0);
  assert.ok(!quiet.logs.some((l) => l.includes("NHẮC")));
});

test("run: mục N1_ALLOW nêu migration không còn ở cây HEAD → 2 ngay (kể cả --detect-only / không đổi migration)", async () => {
  const bad = {
    ...ALLOW_A,
    migration: M("checkout", "Migration20990101000000"),
  };
  for (const [opts, head] of [
    [OPTS, CHANGES_HEAD],
    [{ ...OPTS, detectOnly: true }, CHANGES_HEAD],
    [OPTS, CHANGES_BASE],
  ]) {
    const f = fake({ allow: [bad], head });
    assert.equal(await run("/repo", opts, f.deps), 2);
    assert.deepEqual(f.events, []);
    assert.ok(f.logs.some((l) => l.includes("không còn trong cây HEAD")));
  }
});
/* ------------------------------------------------- so schema: đối tượng ngoài cột/ràng buộc/index (D-124) ---------- */

const lệch = (headRows, baseRows) => diffSchemas(schemaFromRows(headRows), schemaFromRows(baseRows));
const OF = [col("order_finance", "id", { is_nullable: "NO" })];

test("so schema: trigger chỉ ở HEAD trên bảng của module cũ (ca trigger-gap) → lệch", () => {
  const trig = {
    table_name: "order_finance",
    tgname: "order_finance_block",
    def: "CREATE TRIGGER order_finance_block BEFORE UPDATE ON public.order_finance FOR EACH ROW EXECUTE FUNCTION guard()",
  };
  const d = lệch({ columns: OF, triggers: [trig] }, { columns: OF });
  assert.deepEqual(
    d.mismatched.map((m) => m.table),
    ["order_finance"],
  );
  assert.match(d.mismatched[0].onlyHead[0], /^trigger order_finance_block CREATE TRIGGER/);
});

test("so schema: thân function dùng chung khác (md5 prosrc) → lệch; function chỉ ở HEAD → chỉ log", () => {
  const fn = (md5) => ({
    proname: "guard",
    args: "",
    kind: "f",
    result: "trigger",
    src_md5: md5,
  });
  const d = lệch({ columns: OF, functions: [fn("aaa")] }, { columns: OF, functions: [fn("bbb")] });
  assert.deepEqual(
    d.mismatched.map((m) => m.table),
    ["(function) guard()"],
  );
  const only = lệch({ columns: OF, functions: [fn("aaa")] }, { columns: OF });
  assert.deepEqual([only.onlyHead, only.mismatched], [["(function) guard()"], []]);
  // Cùng tên, khác tham số = hai đối tượng khác nhau.
  const ov = lệch({ functions: [{ ...fn("a"), args: "x integer" }] }, { functions: [fn("a")] });
  assert.deepEqual([ov.onlyHead, ov.onlyBase], [["(function) guard(x integer)"], ["(function) guard()"]]);
});

test("so schema: policy và cờ RLS → lệch", () => {
  const pol = {
    table_name: "order_finance",
    policyname: "p",
    permissive: "PERMISSIVE",
    roles: "{public}",
    cmd: "SELECT",
    qual: "(id IS NOT NULL)",
    with_check: null,
  };
  assert.equal(lệch({ columns: OF, policies: [pol] }, { columns: OF }).mismatched.length, 1);
  const rls = (on) => [
    {
      table_name: "order_finance",
      relrowsecurity: on,
      relforcerowsecurity: false,
    },
  ];
  assert.equal(lệch({ columns: OF, rls: rls(true) }, { columns: OF, rls: rls(false) }).mismatched.length, 1);
  assert.equal(lệch({ columns: OF, rls: rls(false) }, { columns: OF, rls: rls(false) }).mismatched.length, 0);
});

test("so schema: nhãn enum khác (thêm/đổi thứ tự) → lệch", () => {
  const en = (labels) => [{ typname: "kind", labels }];
  assert.deepEqual(
    lệch({ enums: en("a,b,c") }, { enums: en("a,b") }).mismatched.map((m) => m.table),
    ["(enum) kind"],
  );
  assert.equal(lệch({ enums: en("b,a") }, { enums: en("a,b") }).mismatched.length, 1);
  assert.equal(lệch({ enums: en("a,b") }, { enums: en("a,b") }).mismatched.length, 0);
});

test("so schema: numeric precision/scale, datetime precision, identity/generated → lệch", () => {
  const c = (extra) => [col("x", "v", extra)];
  const cases = [
    [
      { numeric_precision: 12, numeric_scale: 2 },
      { numeric_precision: 12, numeric_scale: 4 },
    ],
    [{ numeric_precision: 10 }, { numeric_precision: 18 }],
    [{ datetime_precision: 6 }, { datetime_precision: 3 }],
    [{ is_identity: "YES" }, { is_identity: "NO" }],
    [
      { is_generated: "ALWAYS", generation_expression: "(a + b)" },
      { is_generated: "ALWAYS", generation_expression: "(a - b)" },
    ],
  ];
  for (const [h, b] of cases)
    assert.equal(lệch({ columns: c(h) }, { columns: c(b) }).mismatched.length, 1, JSON.stringify(h));
  assert.equal(
    lệch({ columns: c({ numeric_precision: 12 }) }, { columns: c({ numeric_precision: 12 }) }).mismatched
      .length,
    0,
  );
});

test("SCHEMA_SQL: truy vấn đủ loại đối tượng, bỏ trigger nội bộ (FK)", () => {
  for (const k of ["columns", "constraints", "indexes", "triggers", "functions", "policies", "enums", "rls"])
    assert.ok(SCHEMA_SQL[k], k);
  assert.match(SCHEMA_SQL.triggers, /not t\.tgisinternal/);
  assert.match(SCHEMA_SQL.triggers, /pg_get_triggerdef/);
  assert.match(SCHEMA_SQL.functions, /pg_get_function_identity_arguments/);
  assert.match(SCHEMA_SQL.functions, /md5\(/);
  assert.match(
    SCHEMA_SQL.columns,
    /numeric_precision, numeric_scale, datetime_precision, is_identity, is_generated/,
  );
});

test("log khi không đổi migration nêu rõ chỉ xét migration tùy biến (không xét lõi @medusajs)", async () => {
  const f = fake({ head: CHANGES_BASE });
  assert.equal(await run("/repo", OPTS, f.deps), 0);
  assert.ok(f.logs.some((l) => l.includes("không có migration tùy biến") && l.includes("@medusajs")));
});
/* ------------------------------------------- lockfile @medusajs/* (T-195) ------------------------------------- */

/** Lockfile v9 tối thiểu: `medusa` = { gói: phiên bản } vào importers + packages; `other` = gói khác. */
function lock({ medusa = {}, other = {} } = {}) {
  const deps = {
    ...Object.fromEntries(Object.entries(medusa).map(([n, v]) => [`@medusajs/${n}`, v])),
    ...other,
  };
  const importerDeps = Object.entries(deps)
    .map(([n, v]) => `      '${n}':\n        specifier: ${v}\n        version: ${v}`)
    .join("\n");
  const pkgs = Object.entries(deps)
    .map(([n, v]) => `  '${n}@${v}':\n    resolution: {integrity: sha512-x}`)
    .join("\n");
  return `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${importerDeps || "      {}"}\n\npackages:\n\n${pkgs || "  {}"}\n`;
}

test("medusaPackages: lấy tên@phiên bản của @medusajs/* từ packages và importers, bỏ gói khác", () => {
  const set = medusaPackages(
    lock({
      medusa: { framework: "2.22.1", ui: "4.2.8" },
      other: { zod: "4.6.7" },
    }),
  );
  assert.deepEqual([...set].sort(), ["@medusajs/framework@2.22.1", "@medusajs/ui@4.2.8"]);
  assert.equal(medusaPackages(lock()).size, 0);
});

test("medusaPackages: cắt hậu tố peer ở importers; không nhầm gói tên giống (@medusajs-ext, medusajs-x)", () => {
  const text = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@medusajs/ui':
        specifier: 4.2.8
        version: 4.2.8(react@19.3.1)
      medusajs-x:
        specifier: 1.0.0
        version: 1.0.0
packages:
  '@medusajs-ext/a@1.0.0':
    resolution: {integrity: sha512-x}
  'medusajs-x@1.0.0':
    resolution: {integrity: sha512-x}
  '@medusajs/ui@4.2.8':
    resolution: {integrity: sha512-x}
`;
  assert.deepEqual([...medusaPackages(text)].sort(), ["@medusajs/ui@4.2.8"]);
});

test("medusaLockChange: giống hệt → không chạy", () => {
  const l = lock({ medusa: { framework: "2.22.1" }, other: { zod: "4.6.7" } });
  assert.equal(medusaLockChange(l, l).run, false);
});

test("medusaLockChange: đổi phiên bản @medusajs/* → chạy, lý do nêu gói", () => {
  const r = medusaLockChange(
    lock({ medusa: { framework: "2.22.1" } }),
    lock({ medusa: { framework: "2.23.0" } }),
  );
  assert.equal(r.run, true);
  assert.match(r.reason, /@medusajs\/framework@2\.23\.0/);
  assert.equal(r.warning, undefined);
});

test("medusaLockChange: chỉ đổi gói khác → không chạy", () => {
  const m = { framework: "2.22.1" };
  const a = lock({ medusa: m, other: { zod: "4.6.6" } });
  const b = lock({ medusa: m, other: { zod: "4.6.7" } });
  assert.equal(medusaLockChange(a, b).run, false);
});

test("medusaLockChange: thêm hoặc xoá gói @medusajs/* → chạy", () => {
  const a = lock({ medusa: { framework: "2.22.1" } });
  const b = lock({ medusa: { framework: "2.22.1", utils: "2.22.1" } });
  assert.equal(medusaLockChange(a, b).run, true);
  assert.equal(medusaLockChange(b, a).run, true);
  assert.equal(medusaLockChange(lock(), a).run, true);
});

test("medusaLockChange: lockfile hỏng/rỗng/thiếu một phía → chạy (fail-safe) + cảnh báo", () => {
  const ok = lock({ medusa: { framework: "2.22.1" } });
  for (const bad of ["a: [unclosed", "", "just a string", "importers: {}\n", null, undefined]) {
    for (const [x, y] of [
      [bad, ok],
      [ok, bad],
    ]) {
      const r = medusaLockChange(x, y);
      assert.equal(r.run, true, JSON.stringify(bad));
      assert.match(r.warning, /fail-safe/);
    }
  }
});

test("medusaLockChange: lockfile v6 (khoá /@medusajs/a@1.0.0) → chạy (fail-safe)", () => {
  const v6 =
    "lockfileVersion: '6.0'\n\npackages:\n\n  /@medusajs/a@1.0.0:\n    resolution: {integrity: sha512-x}\n";
  const ok = lock({ medusa: { a: "1.0.0" } });
  for (const v of [v6, v6.replace("'6.0'", "5.4")]) {
    assert.throws(() => medusaPackages(v), /lockfileVersion/);
    for (const [x, y] of [
      [v, ok],
      [ok, v],
      [v, v],
    ]) {
      const r = medusaLockChange(x, y);
      assert.equal(r.run, true);
      assert.match(r.warning, /fail-safe/);
    }
  }
});

test("medusaLockChange: lockfile có dấu xung đột merge → chạy (fail-safe)", () => {
  const ok = lock({ medusa: { a: "1.0.0" } });
  for (const mark of ["<<<<<<< HEAD", "=======", ">>>>>>> main"]) {
    const bad = ok.replace("packages:", `${mark}\npackages:`);
    assert.throws(() => medusaPackages(bad), /xung đột/);
    const r = medusaLockChange(ok, bad);
    assert.equal(r.run, true);
    assert.match(r.warning, /fail-safe/);
  }
});

test("medusaPackages: pnpm-lock.yaml thật của repo (v9) vẫn parse được tập @medusajs", () => {
  const real = readFileSync(join(here, "../pnpm-lock.yaml"), "utf8");
  const set = medusaPackages(real);
  assert.ok(set.size > 0);
  for (const k of set) assert.match(k, /^@medusajs\/[^@/]+@\d/);
});

test("medusaLockChange: CRLF + chú thích Unicode không làm hỏng so sánh", () => {
  const l = `${lock({ medusa: { framework: "2.22.1" } }).replace(/\n/g, "\r\n")}# ghi chú tiếng Việt: đổi trả\r\n`;
  assert.equal(medusaLockChange(l, l).run, false);
});

test("run: không đổi migration nhưng đổi @medusajs/* → không bỏ qua; detect ghi run=true + log", async () => {
  const f = fake({ head: CHANGES_BASE, env: { GITHUB_OUTPUT: "/o" } });
  f.deps.baseLockfile = (ref) => (
    assert.equal(ref, "origin/master"),
    lock({ medusa: { framework: "2.22.1" } })
  );
  f.deps.headLockfile = () => lock({ medusa: { framework: "2.23.0" } });
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, f.deps), 0);
  assert.deepEqual(f.events, ["append /o run=true"]);
  assert.ok(f.logs.some((l) => /@medusajs\/framework@2\.23\.0/.test(l)));
  assert.ok(!f.logs.some((l) => /bỏ qua/.test(l)));
});

test("run: không đổi migration, lockfile chỉ đổi gói khác → bỏ qua (run=false)", async () => {
  const f = fake({ head: CHANGES_BASE, env: { GITHUB_OUTPUT: "/o" } });
  f.deps.baseLockfile = () => lock({ medusa: { framework: "2.22.1" }, other: { zod: "1" } });
  f.deps.headLockfile = () => lock({ medusa: { framework: "2.22.1" }, other: { zod: "2" } });
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, f.deps), 0);
  assert.deepEqual(f.events, ["append /o run=false"]);
});

test("run: lockfile hỏng → run=true (fail-safe), ::warning:: trên CI; migration đổi vẫn kích như cũ", async () => {
  const f = fake({
    head: CHANGES_BASE,
    env: { GITHUB_OUTPUT: "/o", GITHUB_ACTIONS: "true" },
  });
  f.deps.baseLockfile = () => "a: [unclosed";
  f.deps.headLockfile = () => "";
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, f.deps), 0);
  assert.deepEqual(f.events, ["append /o run=true"]);
  assert.ok(f.logs.some((l) => l.startsWith("::warning") && /fail-safe/.test(l)));
  const g = fake({ env: { GITHUB_OUTPUT: "/o" } }); // migration đổi, lockfile không đổi → vẫn true
  g.deps.baseLockfile = () => lock();
  g.deps.headLockfile = () => lock();
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, g.deps), 0);
  assert.deepEqual(g.events, ["append /o run=true"]);
});

test("run: hàm đọc lockfile ném lỗi → fail-safe run=true", async () => {
  const f = fake({ head: CHANGES_BASE, env: { GITHUB_OUTPUT: "/o" } });
  f.deps.baseLockfile = () => {
    throw new Error("EIO");
  };
  f.deps.headLockfile = () => lock();
  assert.equal(await run("/repo", { ...OPTS, detectOnly: true }, f.deps), 0);
  assert.deepEqual(f.events, ["append /o run=true"]);
  assert.ok(f.logs.some((l) => l.startsWith("E ") && /EIO/.test(l)));
});

test("lockfile trên repo git thật: đổi @medusajs/* (kể cả chưa commit) → run=true; đổi gói khác → run=false", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "n1-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a) =>
    execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], {
      stdio: "pipe",
    });
  g("init", "-q", "-b", "main");
  const lockPath = join(root, "pnpm-lock.yaml");
  writeFileSync(lockPath, lock({ medusa: { framework: "2.22.1" }, other: { zod: "1" } }));
  g("add", ".");
  g("commit", "-q", "-m", "base");
  const out = join(root, "gh-output");
  const log = { log: () => undefined, error: () => undefined };
  const opts = { base: "HEAD", detectOnly: true, keep: false, workdir: "", testPatterns: [] };
  const go = () => run(root, opts, detectDeps(root, { GITHUB_OUTPUT: out }, log));
  assert.equal(await go(), 0);
  writeFileSync(lockPath, lock({ medusa: { framework: "2.22.1" }, other: { zod: "2" } }));
  assert.equal(await go(), 0);
  writeFileSync(lockPath, lock({ medusa: { framework: "2.23.0" }, other: { zod: "2" } }));
  assert.equal(await go(), 0);
  assert.equal(readFileSync(out, "utf8"), "run=false\nrun=false\nrun=true\n");
});

test("medusaLockChange: chỉ đổi peer (react/zod trong hậu tố) của @medusajs/* → không chạy", () => {
  const mk = (peer) => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@medusajs/ui':
        specifier: 4.2.8
        version: 4.2.8(react@${peer})
packages:
  '@medusajs/ui@4.2.8':
    resolution: {integrity: sha512-x}
snapshots:
  '@medusajs/ui@4.2.8(react@${peer})':
    dependencies:
      react: ${peer}
`;
  const r = medusaLockChange(mk("19.3.0"), mk("19.3.1"));
  assert.equal(r.run, false);
  assert.deepEqual([...medusaPackages(mk("19.3.1"))], ["@medusajs/ui@4.2.8"]);
});

test("detect không phụ thuộc gói ngoài: chạy --detect-only trong thư mục không có node_modules", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "n1-nomods-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const here = dirname(fileURLToPath(import.meta.url));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["n-minus-1.mjs", "check-migrations.mjs"])
    writeFileSync(join(dir, "scripts", f), readFileSync(join(here, f)));
  writeFileSync(join(dir, "pnpm-lock.yaml"), lock({ medusa: { framework: "2.22.1" } }));
  for (const e of N1_ALLOW) {
    // validateAllow đòi các migration trong N1_ALLOW còn trong cây
    mkdirSync(dirname(join(dir, e.migration)), { recursive: true });
    writeFileSync(join(dir, e.migration), "export {};\n");
  }
  const g = (...a) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], {
      stdio: "pipe",
    });
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-q", "-m", "base");
  const out = join(dir, "gh-output");
  // exit 0 (execFileSync ném nếu ≠ 0, kể cả ERR_MODULE_NOT_FOUND) và ghi run=false: không có gì đổi so với HEAD.
  execFileSync(process.execPath, ["scripts/n-minus-1.mjs", "--detect-only", "--base", "HEAD"], {
    cwd: dir,
    stdio: "pipe",
    env: { ...process.env, GITHUB_OUTPUT: out },
  });
  assert.equal(readFileSync(out, "utf8"), "run=false\n");
});
