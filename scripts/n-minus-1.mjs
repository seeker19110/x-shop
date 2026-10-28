#!/usr/bin/env node
// Bản N−1 chạy được trên schema N (OPS-DEPLOY-003, T-163): chạy test tích hợp của code bản trước (ref gốc của PR) trên
// schema do migration của HEAD tạo.
//
//   node scripts/n-minus-1.mjs [--base <ref>] [--test-pattern <regex>]… [--workdir <thư mục>] [--keep]
//   node scripts/n-minus-1.mjs --detect-only [--base <ref>]   # chỉ báo có migration mới/đổi không (ghi run= vào
//                                                              # $GITHUB_OUTPUT nếu có), không cần DB/phụ thuộc
//
// Ref gốc theo ĐÚNG quy tắc của check-migrations: `--base` > biến `MIGRATIONS_BASE_REF` > `origin/master` (CI truyền base
// của PR / commit trước của push / HEAD~1 khi dispatch). Ref không có → exit 2 (không "bỏ qua cho xanh").
// Thay đổi migration = file `apps/backend/src/modules/<m>/migrations/Migration*` thêm/đổi/xoá giữa ref gốc và cây làm
// việc (blob hash của git, như check-migrations). Không có → log rồi exit 0 ngay (không tạo DB, không cài gì).
//
// Vì sao không "migrate một DB rồi trỏ test vào DB đó": `medusaIntegrationTestRunner` (@medusajs/test-utils 2.22.1,
// dist/medusa-test-runner.js) tự tạo DB `medusa-<ulid>-integration-<worker>` cho MỖI suite, tự chạy
// `appLoader.runModulesMigrations()` bằng migration của code đang nạp, snapshot/restore template giữa các ca rồi DROP DB
// cuối suite; tên DB ngẫu nhiên, không nhận từ biến môi trường. DB dựng sẵn không thể đến được tay test nếu không vá
// thư viện. Nên schema N được dựng TRONG cây N−1 bằng cách phủ (overlay) migration của HEAD lên thư mục migrations của
// các module có ở bản N−1; runner của N−1 khi đó tự tạo đúng schema N cho mỗi suite. Hai DB dùng một lần chứng minh
// phép phủ trung thực:
//   A = `medusa db:migrate` bằng mã HEAD (cây làm việc) · B = `medusa db:migrate` bằng mã N−1 + overlay.
//   Schema `public` của A và B (cột/kiểu/NULL/DEFAULT, ràng buộc, index) phải trùng trên mọi bảng có ở B; bảng chỉ có ở A
//   (module/link mới mà N−1 không nạp) chỉ ghi log. Lệch → exit 2 (không kết luận được): vd HEAD nâng @medusajs (migration
//   lõi khác) hay migration của module mới ALTER bảng của module cũ.
//
// Thứ tự: git archive <ref gốc> → thư mục tạm · `pnpm install --frozen-lockfile --prefer-offline --filter
// @x-shop/backend...` trong cây N−1 (store pnpm dùng chung với cây HEAD = cache; CI: store do bước setup của job nạp) ·
// phủ migration · build @x-shop/domain hai cây · CREATE DATABASE A, B (`xshop_n1_<hex>_head|_base`) · db:migrate A (HEAD),
// B (N−1+overlay) · so schema · DROP A, B · `pnpm run test:integration [pattern…]` của cây N−1 (biến môi trường như lệnh
// test tích hợp thường: DATABASE_URL/REDIS_URL của máy/CI; runner tự tạo/xoá DB của nó). Dọn (xoá thư mục tạm trừ
// `--keep`, DROP DB do chính lần chạy tạo) ở mọi nhánh: thành công, lỗi, và SIGINT/SIGTERM (chuyển tín hiệu cho nhóm
// tiến trình con đang chạy — theo pid, không theo tên — chờ nó thoát, dọn, rồi thoát 130/143).
// Có suite đỏ → không quy ngay cho migration (lần chạy thật đầu tiên gặp ref gốc có test tự đỏ sẵn): chạy lại CHỈ các
// suite đỏ trên schema N (xác nhận) rồi gỡ phần phủ và chạy trên schema N−1 (đối chứng) — xem classifyFailures.
//
// Biến: N1_PG_BASE_URL (mặc định: DATABASE_URL bỏ tên DB, không có thì postgres://xshop:xshop@localhost:5432 — dịch vụ
// cục bộ/CI, không phải bí mật) · N1_WORKDIR (thư mục cha của thư mục tạm, mặc định os.tmpdir()) · GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY (CI: kết quả detect, bảng thời gian).
//
// Thoát 0 = đạt (kể cả suite chỉ chập chờn) hoặc không có migration đổi; 1 = suite xanh trên schema N−1 mà đỏ trên schema
// N (không tương thích ngược); 2 = không kết luận được (ref gốc không có, cài/migrate lỗi, overlay không tái tạo được
// schema N, DB lỗi, báo cáo jest không đọc được, suite tự đỏ ở bản N−1 ngay trên schema của nó).
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_BASE,
  MIGRATION_FILE,
  baseMigrations,
  listMigrations,
  refExists,
  worktreeHashes,
} from "./check-migrations.mjs";

const MODULES_DIR = "apps/backend/src/modules";
export const SAFE_DB = /^xshop_[a-z0-9_]+$/;
export const DEFAULT_PG_BASE = "postgres://xshop:xshop@localhost:5432";
/** Môi trường của `medusa db:migrate` (như --drift của check-migrations): không Redis, không Admin. */
const MEDUSA_ENV = { NODE_ENV: "development", REDIS_URL: "", DISABLE_MEDUSA_ADMIN: "true" };
const KILL_GRACE_MS = 15000;
const QUIET_TAIL = 8000;

/* ------------------------------------------------------------- thuần ---------------------------------------- */

export function parseArgs(argv, env = {}) {
  const opts = {
    base: env.MIGRATIONS_BASE_REF || DEFAULT_BASE,
    detectOnly: false,
    keep: false,
    workdir: env.N1_WORKDIR || "",
    testPatterns: [],
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} cần một giá trị`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = value(++i, a);
    else if (a.startsWith("--base=")) opts.base = a.slice(7);
    else if (a === "--detect-only") opts.detectOnly = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--workdir") opts.workdir = value(++i, a);
    else if (a.startsWith("--workdir=")) opts.workdir = a.slice(10);
    else if (a === "--test-pattern") opts.testPatterns.push(value(++i, a));
    else if (a.startsWith("--test-pattern=")) opts.testPatterns.push(a.slice(15));
    else throw new Error(`tham số lạ: ${a}`);
  }
  if (!opts.base) throw new Error("--base cần một ref");
  for (const p of opts.testPatterns) if (!p) throw new Error("--test-pattern rỗng");
  return opts;
}

/** postgres://user:pass@host:port (không tên DB, không query) từ N1_PG_BASE_URL / DATABASE_URL / mặc định. */
export function pgBaseUrl(env = {}) {
  if (env.N1_PG_BASE_URL) return env.N1_PG_BASE_URL.replace(/\/+$/, "");
  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL);
    return `${u.protocol}//${u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : ""}${u.host}`;
  }
  return DEFAULT_PG_BASE;
}

/** Tên hai DB dùng một lần của một lần chạy (hậu tố ngẫu nhiên → hai lần chạy đồng thời không đụng nhau). */
export function dbNames(hex = randomBytes(6).toString("hex")) {
  const head = `xshop_n1_${hex}_head`;
  const base = `xshop_n1_${hex}_base`;
  if (!SAFE_DB.test(head) || !SAFE_DB.test(base)) throw new Error(`tên DB không an toàn: ${head}`);
  return { head, base };
}

/**
 * So hai Map<đường dẫn, blob hash> (ref gốc ↔ cây làm việc) → { added, changed, removed } (đã sắp xếp). Chỉ tính file
 * migration (MIGRATION_FILE); snapshot `.snapshot-*.json` không ảnh hưởng schema lúc chạy.
 */
export function migrationChanges(base, head) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [p, h] of head) {
    if (!MIGRATION_FILE.test(p)) continue;
    if (!base.has(p)) added.push(p);
    else if (base.get(p) !== h) changed.push(p);
  }
  for (const p of base.keys()) if (MIGRATION_FILE.test(p) && !head.has(p)) removed.push(p);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

export const hasChanges = (c) => c.added.length + c.changed.length + c.removed.length > 0;

/** Tên thư mục module của một đường dẫn migration. */
export const moduleOf = (p) => p.slice(MODULES_DIR.length + 1).split("/")[0];

/**
 * Kế hoạch phủ: file thêm/đổi của module có ở cây N−1 → chép; file bị xoá ở HEAD → xoá khỏi cây N−1; module chỉ có ở
 * HEAD (N−1 không nạp) → bỏ qua, ghi tên (bảng của nó chỉ có ở DB A, được phép).
 */
export function planOverlay(changes, moduleInBase) {
  const copy = [];
  const remove = [];
  const newModules = new Set();
  for (const p of [...changes.added, ...changes.changed]) {
    if (moduleInBase(moduleOf(p))) copy.push(p);
    else newModules.add(moduleOf(p));
  }
  for (const p of changes.removed) if (moduleInBase(moduleOf(p))) remove.push(p);
  return { copy, remove, newModules: [...newModules].sort() };
}

/**
 * Các bước chạy lệnh (thuần, để test): { id, title, cmd, args, cwd, env? }. `root` = cây HEAD, `baseDir` = cây N−1.
 */
export function buildSteps({ root, baseDir, pgBase, dbs, testPatterns = [], resultsDir = baseDir }) {
  const migrateArgs = [
    "exec",
    "medusa",
    "db:migrate",
    "--skip-scripts",
    "--execute-safe-links",
    "--execute-safe-search",
  ];
  return {
    install: {
      id: "install",
      title: "cài phụ thuộc cây N−1 (store pnpm dùng chung)",
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--filter", "@x-shop/backend..."],
      cwd: baseDir,
    },
    buildHead: {
      id: "build-head",
      title: "build @x-shop/domain (HEAD)",
      cmd: "pnpm",
      args: ["--filter", "@x-shop/domain", "build"],
      cwd: root,
    },
    buildBase: {
      id: "build-base",
      title: "build @x-shop/domain (N−1)",
      cmd: "pnpm",
      args: ["--filter", "@x-shop/domain", "build"],
      cwd: baseDir,
    },
    migrateHead: {
      id: "migrate-head",
      title: `db:migrate mã HEAD → ${dbs.head}`,
      cmd: "pnpm",
      args: migrateArgs,
      cwd: join(root, "apps/backend"),
      env: { ...MEDUSA_ENV, DATABASE_URL: `${pgBase}/${dbs.head}` },
      quiet: true,
    },
    migrateBase: {
      id: "migrate-base",
      title: `db:migrate mã N−1 + migration HEAD → ${dbs.base}`,
      cmd: "pnpm",
      args: migrateArgs,
      cwd: join(baseDir, "apps/backend"),
      env: { ...MEDUSA_ENV, DATABASE_URL: `${pgBase}/${dbs.base}` },
      quiet: true,
    },
    test: {
      id: "test",
      title: "test tích hợp của N−1 trên schema N",
      cmd: "pnpm",
      args: [
        "run",
        "test:integration",
        ...testPatterns,
        "--json",
        `--outputFile=${join(resultsDir, "test.json")}`,
      ],
      cwd: join(baseDir, "apps/backend"),
      results: join(resultsDir, "test.json"),
    },
    /** Chạy lại đúng các suite đỏ (đường dẫn tuyệt đối, `--runTestsByPath` — không hiểu là regex). */
    retest: (id, title, paths) => ({
      id,
      title,
      cmd: "pnpm",
      args: [
        "run",
        "test:integration",
        "--runTestsByPath",
        ...paths,
        "--json",
        `--outputFile=${join(resultsDir, `${id}.json`)}`,
      ],
      cwd: join(baseDir, "apps/backend"),
      results: join(resultsDir, `${id}.json`),
    }),
  };
}

/**
 * Đường dẫn suite đỏ từ báo cáo `jest --json` (`testResults[].status === "failed"`, gồm suite lỗi khi nạp). Báo cáo
 * không đọc được → null (không phân loại được).
 */
export function failedSuites(json) {
  if (json === null || json === undefined) return null;
  let r;
  try {
    r = typeof json === "string" || Buffer.isBuffer(json) ? JSON.parse(String(json)) : json;
  } catch {
    return null;
  }
  if (!Array.isArray(r?.testResults)) return null;
  return r.testResults
    .filter((t) => t.status === "failed")
    .map((t) => t.name)
    .sort();
}

/**
 * Phân loại suite đỏ ở lần chạy đầu (schema N) bằng hai lần chạy lại CHỈ các suite đó: `confirm` (vẫn schema N) và
 * `control` (bỏ phần phủ → schema N−1, đúng bản N−1 nguyên gốc).
 *   đỏ cả ở control → `baseRed` (bản N−1 tự đỏ, không do schema — vd test hỏng/chập chờn có sẵn trên ref gốc)
 *   xanh ở control, đỏ lại ở confirm → `incompatible` (đỏ chỉ khi có migration của HEAD)
 *   xanh ở cả hai → `flaky` (chỉ cảnh báo)
 * Mã: incompatible → 1; còn baseRed → 2 (không kết luận được cho các suite đó); chỉ flaky → 0.
 */
export function classifyFailures(failed, confirmFailed, controlFailed) {
  const confirm = new Set(confirmFailed);
  const control = new Set(controlFailed);
  const out = { incompatible: [], baseRed: [], flaky: [] };
  for (const f of failed) {
    if (control.has(f)) out.baseRed.push(f);
    else if (confirm.has(f)) out.incompatible.push(f);
    else out.flaky.push(f);
  }
  out.code = out.incompatible.length ? 1 : out.baseRed.length ? 2 : 0;
  return out;
}

/**
 * So schema của DB A (HEAD) và B (N−1 + overlay): mỗi tham số là Map<bảng, string[]> (dòng mô tả cột/ràng buộc/index).
 * → { onlyHead: [bảng], onlyBase: [bảng], mismatched: [{ table, onlyHead: [dòng], onlyBase: [dòng] }] }.
 */
export function diffSchemas(head, base) {
  const onlyHead = [];
  const onlyBase = [];
  const mismatched = [];
  for (const t of [...head.keys()].sort()) if (!base.has(t)) onlyHead.push(t);
  for (const t of [...base.keys()].sort()) {
    if (!head.has(t)) {
      onlyBase.push(t);
      continue;
    }
    const h = new Set(head.get(t));
    const b = new Set(base.get(t));
    const oh = [...h].filter((x) => !b.has(x)).sort();
    const ob = [...b].filter((x) => !h.has(x)).sort();
    if (oh.length || ob.length) mismatched.push({ table: t, onlyHead: oh, onlyBase: ob });
  }
  return { onlyHead, onlyBase, mismatched };
}

/**
 * DEFAULT sinh lúc chạy migration, khác nhau giữa hai DB dù cùng migration: migration lõi của Medusa 2.22.1 đặt
 * `workflow_execution.run_id` DEFAULT là một ULID literal tạo khi migrate (đo 2026-10-27). Chỉ thay ULID literal (26 ký tự
 * Crockford base32 trong nháy đơn) — DEFAULT khác vẫn so nguyên văn.
 */
export const normalizeDefault = (d) =>
  d === null || d === undefined ? "-" : String(d).replace(/'[0-9A-HJKMNP-TV-Z]{26}'/g, "'<ulid>'");

/** Dòng thô từ catalog → Map<bảng, string[]>. */
export function schemaFromRows({ columns = [], constraints = [], indexes = [] }) {
  const out = new Map();
  const add = (t, line) => {
    if (!out.has(t)) out.set(t, []);
    out.get(t).push(line);
  };
  for (const c of columns)
    add(
      c.table_name,
      `column ${c.column_name} ${c.data_type}/${c.udt_name}${c.character_maximum_length ? `(${c.character_maximum_length})` : ""} ${c.is_nullable === "YES" ? "null" : "not null"} default ${normalizeDefault(c.column_default)}`,
    );
  for (const c of constraints) add(c.table_name, `constraint ${c.conname} ${c.def}`);
  for (const i of indexes) add(i.table_name, `index ${i.indexname} ${i.indexdef}`);
  for (const lines of out.values()) lines.sort();
  return out;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/* -------------------------------------------------------------- I/O ---------------------------------------- */

const SCHEMA_SQL = {
  columns: `select table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable, column_default
              from information_schema.columns where table_schema = 'public'`,
  constraints: `select c.conrelid::regclass::text as table_name, c.conname, pg_get_constraintdef(c.oid) as def
                  from pg_constraint c where c.connamespace = 'public'::regnamespace and c.conrelid <> 0`,
  indexes: `select tablename as table_name, indexname, indexdef from pg_indexes where schemaname = 'public'`,
};

function pgClient(root, url) {
  const { Client } = createRequire(join(root, "package.json"))("pg");
  return new Client({ connectionString: url });
}

async function withClient(root, url, fn) {
  const c = pgClient(root, url);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Chạy lệnh trong nhóm tiến trình riêng (detached) để chuyển tín hiệu cho cả cây con theo pid. In output trực tiếp. */
function spawnStep(step, { onChild, out = process.stdout, err = process.stderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.cmd, step.args, {
      cwd: step.cwd,
      env: { ...process.env, ...step.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onChild?.(child);
    // `quiet` (db:migrate in ~600 dòng log JSON): giữ đuôi, chỉ in khi bước đỏ.
    let tail = "";
    const keep = (d) => {
      tail = (tail + d.toString()).slice(-QUIET_TAIL);
    };
    child.stdout.on("data", (d) => (step.quiet ? keep(d) : out.write(d)));
    child.stderr.on("data", (d) => (step.quiet ? keep(d) : err.write(d)));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      onChild?.(null);
      const rc = code ?? (signal ? 128 : 1);
      if (step.quiet && rc !== 0) err.write(tail);
      resolve({ code: rc, signal });
    });
  });
}

/** git archive <sha> | tar -x -C <dir>. */
function extractTree(root, sha, dir) {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", root, "archive", "--format=tar", sha], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let errs = "";
    archive.stderr.on("data", (d) => (errs += d));
    tar.stderr.on("data", (d) => (errs += d));
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    let failed = false;
    const done = (name) => (code) => {
      if (code !== 0) failed = true;
      if (code !== 0 && !errs) errs = `${name} thoát mã ${code}`;
      if (--pending === 0) (failed ? reject(new Error(errs.trim())) : resolve)();
    };
    archive.on("error", reject);
    tar.on("error", reject);
    archive.on("close", done("git archive"));
    tar.on("close", done("tar"));
  });
}

export function realDeps(root) {
  let current = null;
  return {
    env: process.env,
    proc: process,
    log: console,
    now: () => Date.now(),
    refExists: (ref) => refExists(root, ref),
    resolveSha: (ref) =>
      execFileSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], {
        encoding: "utf8",
      }).trim(),
    baseMigrations: (ref) => baseMigrations(root, ref),
    headMigrations: () => worktreeHashes(root, listMigrations(root)),
    mkdtemp: (parent) => {
      mkdirSync(parent, { recursive: true });
      return mkdtempSync(join(parent, "xshop-n1-"));
    },
    rm: (dir) => rmSync(dir, { recursive: true, force: true }),
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    extract: (sha, dir) => extractTree(root, sha, dir),
    exists: (p) => existsSync(p),
    /** Nội dung file (Buffer) hoặc null nếu không có. */
    readFile: (p) => (existsSync(p) ? readFileSync(p) : null),
    writeFile: (p, data) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    },
    unlink: (p) => rmSync(p, { force: true }),
    admin: (pgBase, sql) => withClient(root, `${pgBase}/postgres`, (c) => c.query(sql)),
    readSchema: async (pgBase, db) =>
      withClient(root, `${pgBase}/${db}`, async (c) => {
        const rows = {};
        for (const [k, sql] of Object.entries(SCHEMA_SQL)) rows[k] = (await c.query(sql)).rows;
        return schemaFromRows(rows);
      }),
    exec: (step) => spawnStep(step, { onChild: (c) => (current = c) }),
    /** Chuyển tín hiệu cho nhóm tiến trình con đang chạy (pid âm = cả nhóm); hết hạn chờ → SIGKILL. */
    killCurrent: (sig) =>
      new Promise((resolve) => {
        const child = current;
        if (!child || child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* đã thoát */
          }
        }, KILL_GRACE_MS);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          process.kill(-child.pid, sig);
        } catch {
          clearTimeout(timer);
          resolve();
        }
      }),
    appendFile: (file, text) => appendFileSync(file, text),
  };
}

/* ------------------------------------------------------------- chạy ---------------------------------------- */

/**
 * Toàn bộ quy trình. `deps` thay mọi I/O (test): xem realDeps. Trả mã thoát.
 */
export async function run(root, opts, deps = realDeps(root)) {
  const { env, log, proc } = deps;
  const tag = "n-minus-1";
  if (!deps.refExists(opts.base)) {
    log.error(
      `${tag}: ref gốc "${opts.base}" không có trong repo (clone nông/chưa fetch?) — \`git fetch origin <nhánh>\` (CI: fetch-depth: 0) hoặc --base <ref>.`,
    );
    return 2;
  }
  let changes;
  try {
    changes = migrationChanges(deps.baseMigrations(opts.base), deps.headMigrations());
  } catch (e) {
    log.error(`${tag}: không đọc được migration: ${e.message}`);
    return 2;
  }
  const changed = hasChanges(changes);
  if (opts.detectOnly && env.GITHUB_OUTPUT) deps.appendFile(env.GITHUB_OUTPUT, `run=${changed}\n`);
  if (!changed) {
    log.log(`${tag}: không có migration thêm/đổi/xoá so với ${opts.base} — bỏ qua (schema N = schema N−1).`);
    return 0;
  }
  for (const k of ["added", "changed", "removed"])
    for (const p of changes[k]) log.log(`${tag}: migration ${k}: ${p}`);
  if (opts.detectOnly) return 0;

  const pgBase = pgBaseUrl(env);
  const dbs = dbNames(deps.hex?.());
  const timings = [];
  const created = new Set();
  let workdir = null;
  let cleaning = null;
  let aborted = null;

  const dropDb = async (db) => {
    if (!created.has(db)) return;
    try {
      await deps.admin(pgBase, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      created.delete(db);
    } catch (e) {
      log.error(`${tag}: không xoá được DB ${db} (xoá tay): ${e.message}`);
    }
  };
  const cleanup = () =>
    (cleaning ??= (async () => {
      for (const db of [dbs.head, dbs.base]) await dropDb(db);
      if (workdir && !opts.keep) {
        try {
          deps.rm(workdir);
        } catch (e) {
          log.error(`${tag}: không xoá được ${workdir} (xoá tay): ${e.message}`);
        }
      } else if (workdir) log.log(`${tag}: --keep — giữ cây N−1 ở ${workdir}`);
    })());
  const signalCode = (sig) => (sig === "SIGINT" ? 130 : 143);
  const onSignal = (sig) => {
    if (aborted) return;
    aborted = sig;
    log.error(`${tag}: nhận ${sig} — dừng tiến trình con, xoá DB và thư mục tạm rồi thoát`);
    // Bước đang chạy không qua exec (git archive, truy vấn DB) vẫn dừng ở bước kế (kiểm `aborted`) và dọn ở `finally`;
    // nhánh này dọn + thoát luôn để không treo nếu bước hiện tại không trả về. `cleanup` chỉ chạy một lần.
    Promise.resolve()
      .then(() => deps.killCurrent(sig))
      .catch(() => undefined)
      .then(cleanup)
      .finally(() => proc.exit(signalCode(sig)));
  };
  proc.once("SIGINT", onSignal);
  proc.once("SIGTERM", onSignal);

  const timed = async (title, fn) => {
    const t0 = deps.now();
    log.log(`${tag}: ▶ ${title}`);
    try {
      return await fn();
    } finally {
      timings.push({ title, ms: deps.now() - t0 });
    }
  };
  const step = async (s) => {
    if (aborted) throw new Error(`đã nhận ${aborted}`);
    const r = await timed(s.title, () => deps.exec(s));
    // Runner của Medusa bắt SIGTERM rồi thoát 0 — bước bị ngắt không được tính là xanh.
    if (aborted) throw new Error(`đã nhận ${aborted}`);
    if (r.code !== 0) throw Object.assign(new Error(`${s.title}: thoát mã ${r.code}`), { code: r.code });
  };
  /** Chạy test (mã khác 0 không ném) → { code, failed: [suite đỏ] | null }. */
  const testRun = async (s) => {
    if (aborted) throw new Error(`đã nhận ${aborted}`);
    const r = await timed(s.title, () => deps.exec(s));
    if (aborted) throw new Error(`đã nhận ${aborted}`);
    return { code: r.code, failed: failedSuites(deps.readFile(s.results)) };
  };
  const pipeline = async () => {
    const sha = deps.resolveSha(opts.base);
    workdir = deps.mkdtemp(opts.workdir || tmpdir());
    const baseDir = join(workdir, "base");
    log.log(`${tag}: ref gốc ${opts.base} = ${sha}; cây N−1 ở ${baseDir}`);
    const steps = buildSteps({
      root,
      baseDir,
      pgBase,
      dbs,
      testPatterns: opts.testPatterns,
      resultsDir: workdir,
    });
    await timed("git archive ref gốc", async () => {
      deps.mkdir(baseDir);
      await deps.extract(sha, baseDir);
    });
    await step(steps.install);
    const plan = planOverlay(changes, (m) => deps.exists(join(baseDir, MODULES_DIR, m, "index.ts")));
    // Giữ nội dung gốc của cây N−1 để gỡ phần phủ (lần chạy đối chứng trên schema N−1).
    const original = new Map();
    for (const p of [...plan.copy, ...plan.remove]) original.set(p, deps.readFile(join(baseDir, p)));
    for (const p of plan.copy) deps.writeFile(join(baseDir, p), deps.readFile(join(root, p)));
    for (const p of plan.remove) deps.unlink(join(baseDir, p));
    const unOverlay = () => {
      for (const [p, data] of original) {
        if (data === null) deps.unlink(join(baseDir, p));
        else deps.writeFile(join(baseDir, p), data);
      }
    };
    log.log(`${tag}: phủ ${plan.copy.length} file, xoá ${plan.remove.length} file migration vào cây N−1`);
    for (const m of plan.newModules)
      log.log(`${tag}: module ${m} chỉ có ở HEAD — bản N−1 không nạp, migration của nó chỉ chạy ở DB HEAD`);
    await step(steps.buildHead);
    await step(steps.buildBase);
    for (const db of [dbs.head, dbs.base]) {
      if (aborted) throw new Error(`đã nhận ${aborted}`);
      await deps.admin(pgBase, `CREATE DATABASE "${db}"`);
      created.add(db);
    }
    await step(steps.migrateHead);
    await step(steps.migrateBase);
    const diff = await timed("so schema HEAD ↔ N−1+overlay", async () =>
      diffSchemas(await deps.readSchema(pgBase, dbs.head), await deps.readSchema(pgBase, dbs.base)),
    );
    for (const t of diff.onlyHead)
      log.log(`${tag}: bảng chỉ có ở schema HEAD (N−1 không nạp module/link): ${t}`);
    if (diff.onlyBase.length || diff.mismatched.length) {
      for (const t of diff.onlyBase) log.error(`${tag}: bảng chỉ có ở N−1+overlay: ${t}`);
      for (const m of diff.mismatched) {
        log.error(`${tag}: bảng ${m.table} lệch:`);
        for (const l of m.onlyHead) log.error(`  chỉ ở HEAD:        ${l}`);
        for (const l of m.onlyBase) log.error(`  chỉ ở N−1+overlay: ${l}`);
      }
      log.error(
        `${tag}: LỖI: phủ migration HEAD lên cây N−1 không tái tạo được schema N (HEAD đổi phiên bản Medusa? migration module mới ALTER bảng cũ?) — không kết luận được`,
      );
      return 2;
    }
    log.log(`${tag}: schema N−1+overlay trùng schema HEAD trên mọi bảng bản N−1 biết`);
    for (const db of [dbs.head, dbs.base]) await dropDb(db);
    const short = sha.slice(0, 12);
    const first = await testRun(steps.test);
    if (first.code === 0) {
      log.log(`${tag}: ĐẠT — test tích hợp của bản N−1 (${short}) xanh trên schema N`);
      return 0;
    }
    if (!first.failed?.length) {
      log.error(
        `${tag}: LỖI: test tích hợp thoát mã ${first.code} mà báo cáo jest không nêu suite đỏ (${steps.test.results}) — không kết luận được`,
      );
      return 2;
    }
    log.error(
      `${tag}: ${first.failed.length} suite đỏ trên schema N — chạy lại riêng chúng trên schema N (xác nhận) và schema N−1 (đối chứng)`,
    );
    const confirm = await testRun(steps.retest("confirm", "chạy lại suite đỏ — schema N", first.failed));
    unOverlay();
    const control = await testRun(
      steps.retest("control", "đối chứng suite đỏ — schema N−1 (bỏ phủ)", first.failed),
    );
    if (confirm.failed === null || control.failed === null) {
      log.error(`${tag}: LỖI: không đọc được báo cáo jest của lần chạy lại — không kết luận được`);
      return 2;
    }
    const c = classifyFailures(first.failed, confirm.failed, control.failed);
    const rel = (p) => (p.startsWith(baseDir) ? p.slice(baseDir.length + 1) : p);
    for (const f of c.incompatible)
      log.error(`${tag}: KHÔNG TƯƠNG THÍCH: ${rel(f)} — xanh trên schema N−1, đỏ (2 lần) trên schema N`);
    for (const f of c.baseRed)
      log.error(`${tag}: N−1 TỰ ĐỎ: ${rel(f)} — đỏ cả trên schema N−1 của chính nó (không do migration)`);
    for (const f of c.flaky)
      log.error(`${tag}: CHẬP CHỜN: ${rel(f)} — đỏ lần đầu, xanh khi chạy lại cả hai schema`);
    if (c.code === 1)
      log.error(
        `${tag}: ĐỎ — bản N−1 (${short}) không chạy được trên schema N: migration của HEAD không tương thích ngược (OPS-DEPLOY-003) — tách expand/contract (RUNBOOK §5).`,
      );
    else if (c.code === 2)
      log.error(
        `${tag}: KHÔNG KẾT LUẬN ĐƯỢC — suite trên tự đỏ ở bản N−1 (${short}); các suite còn lại xanh trên schema N. Sửa/đánh dấu test trên ref gốc rồi chạy lại.`,
      );
    else log.log(`${tag}: ĐẠT (có suite chập chờn ở trên) — bản N−1 (${short}) xanh trên schema N`);
    return c.code;
  };

  const t0 = deps.now();
  let exit;
  try {
    exit = await pipeline();
  } catch (e) {
    log.error(`${tag}: LỖI: ${e.message}`);
    exit = 2;
  }
  proc.off("SIGINT", onSignal);
  proc.off("SIGTERM", onSignal);
  await cleanup();
  if (aborted) exit = signalCode(aborted);
  timings.push({ title: "tổng", ms: deps.now() - t0 });
  const table = timings.map((t) => `| ${t.title} | ${formatDuration(t.ms)} |`).join("\n");
  log.log(`${tag}: mã ${exit}; thời gian\n${table}`);
  if (env.GITHUB_STEP_SUMMARY)
    deps.appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### n-minus-1 (ref gốc ${opts.base}) — mã ${exit}\n\n| bước | thời gian |\n|---|---|\n${table}\n`,
    );
  return exit;
}

export async function main(
  argv = process.argv.slice(2),
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  let opts;
  try {
    opts = parseArgs(argv, process.env);
  } catch (e) {
    console.error(`n-minus-1: ${e.message}`);
    return 2;
  }
  return run(root, opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
