#!/usr/bin/env node
// Kiểm migration của module tùy biến (`apps/backend/src/modules/<module>/migrations/Migration*.ts`) — T-102.
//
//   node scripts/check-migrations.mjs [--base <ref>] [--all]   # bất biến + expand/contract (không cần DB)
//   node scripts/check-migrations.mjs --drift [--keep-generated] # drift model ↔ migration (cần Postgres)
//
// 1. BẤT BIẾN (DB-MIG-003): mọi file migration có trên ref gốc (`--base`, biến `MIGRATIONS_BASE_REF`, mặc định
//    `origin/master`; CI truyền base của PR / commit trước của push) phải giữ nguyên byte — so blob hash của git
//    (`git ls-tree` trên ref gốc ↔ `git hash-object` của cây làm việc, qua bộ lọc clean/eol của git, nên sửa chưa commit
//    cũng bị bắt mà CRLF do checkout không báo nhầm). Sửa hay xoá/di chuyển → đỏ, in tên file. Ref gốc không có (clone
//    nông, chưa fetch) → đỏ (exit 2), không "bỏ qua cho xanh".
// 2. EXPAND/CONTRACT (DB-MIG-008, OPS-DEPLOY-003 — bản N−1 phải chạy được trên schema N): chỉ áp cho migration MỚI (chưa
//    có trên ref gốc); migration trên ref gốc được miễn (mục 1 khoá nội dung) — `--all` soát cả chúng.
//    Lấy SQL THẬT: transpile file bằng `typescript` (đã có trong devDependencies) rồi chạy `up()` trong `node:vm` với
//    class `Migration` giả có `addSql` ghi lại chuỗi — nên nối `+`, `${…}`, `.map().join()`, hằng/hàm phụ đều thấy đúng
//    SQL; `down()` không chạy. Không phân tích được → đỏ (luật `unanalyzable`): import khác
//    "@medusajs/framework/mikro-orm/migrations", knex/`getKnex()`/`execute()`, `addSql` nhận giá trị không phải chuỗi,
//    `up()` ném lỗi; `dynamic-sql`: PL/pgSQL `execute …`/`format('<DDL>…')` (SQL dựng lúc chạy trong DB).
//    Schema N−1 = bảng/cột/tên ràng buộc & index do các migration trên ref gốc tạo (chạy `up()` của chúng cùng cách).
//    Luật (theo THỨ TỰ câu lệnh trong `up()`):
//      drop-table · drop-column · rename-table (kể cả SET SCHEMA) · rename-column · alter-column-type · set-not-null ·
//      add-required-column (NOT NULL/PRIMARY KEY không DEFAULT trên bảng có sẵn) · truncate · delete-without-where
//      (kể cả WHERE true / 1=1) · drop-index / drop-constraint (tên do migration trên ref gốc tạo mà không tạo lại SAU
//      đó trong cùng up()) · drop-object (view/type/sequence/schema không tạo lại sau đó).
//    Miễn chỉ khi bảng được `create table` TRƯỚC thao tác trong cùng up() và không có trên ref gốc; cột được `add column`
//    TRƯỚC, không có trên ref gốc, trên bảng đã biết — SET NOT NULL còn đòi cột thêm kèm DEFAULT (INSERT của N−1 không
//    ghi cột đó). `drop constraint|index if exists` rồi tạo lại cùng tên (mẫu idempotent) không bị chặn.
//    Thao tác phá huỷ chỉ được phép khi file có cờ trong CHÚ THÍCH TS (AST của typescript — không tính chuỗi/regex/SQL):
//      // @migration-contract: <lý do ≥ 15 ký tự, nêu migration expand, vd Migration20261027100000>
//    Migration expand được nêu phải có trên ref gốc, hoặc là migration khác trong cây làm việc sắp TRƯỚC file này theo
//    tên. Cờ thiếu lý do / không nêu expand / nêu chính nó → đỏ. `unanalyzable`/`dynamic-sql` không miễn bằng cờ.
//    Không dùng squawk (tra 2026-10-27: squawkhq.com/docs/cli + `npm view squawk-cli@2.70.0`): chỉ lint file .sql/stdin,
//    không đọc SQL nằm trong TS, và cần nhị phân Rust theo nền tảng (optionalDependencies @squawk-cli/*).
// 3. DRIFT (DB-MIG-001, `--drift`): DB dùng một lần (`xshop_drift_<hex>`, hoặc `DRIFT_DB_NAME` khớp ^xshop_[a-z0-9_]+$)
//    trên `DRIFT_PG_BASE_URL` (mặc định postgres://xshop:xshop@localhost:5432 — dịch vụ cục bộ/CI, không phải bí mật):
//    build domain → `medusa db:migrate --skip-links` → `medusa db:generate <module tùy biến có models/>` (cú pháp
//    `db:generate [modules...]` — @medusajs/cli 2.22.1 dist/create-cli.js). MikroORM so model DML với snapshot
//    `.snapshot-*.json` đi cùng migration → có file mới/đổi trong `migrations/` = drift (đỏ, in nội dung). db:generate
//    của @medusajs/utils 2.22.1 nuốt lỗi từng module ("Failed with error …") rồi vẫn thoát 0 → đếm dòng
//    "Generated successfully"/"Skipped. No changes detected" phải bằng số module, có "Failed with error" → đỏ (exit 2).
//    Sau đó trả các file về như trước (trừ `--keep-generated`) và xoá DB do chính lần chạy tạo (cả khi SIGINT/SIGTERM).
//    Giới hạn: so với snapshot, không với schema DB thật (`check:schema` soát catalog).
//
// Thoát 0 = đạt; 1 = vi phạm; 2 = không đọc được đầu vào / ref gốc không có / lỗi DB / db:generate lỗi.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const MODULES_DIR = "apps/backend/src/modules";
export const MIGRATION_FILE =
  /^apps\/backend\/src\/modules\/[^/]+\/migrations\/Migration[^/]*\.(ts|js|mjs|cjs)$/;
export const MIGRATION_MODULE = "@medusajs/framework/mikro-orm/migrations";
const CONTRACT_FLAG = /@migration-contract:([^\n]*)/;
const MIGRATION_NAME = /\bMigration\d{14}\b/g;
const MIN_REASON = 15;
export const DEFAULT_BASE = "origin/master";

/** Luật không miễn được bằng cờ contract (không biết SQL thật là gì). */
const NOT_CONTRACTABLE = new Set(["unanalyzable", "dynamic-sql"]);

const HINT = {
  "set-not-null":
    " — tách: migration expand thêm `CHECK (<cột> IS NOT NULL) NOT VALID` (+ code ghi đủ, backfill), rồi `VALIDATE CONSTRAINT`, rồi `SET NOT NULL` ở migration contract phát hành sau",
  "add-required-column": " — thêm cột kèm DEFAULT, hoặc nullable rồi SET NOT NULL ở migration contract sau",
  unanalyzable: " — chỉ import Migration, gọi this.addSql(<chuỗi>) (không knex/execute)",
  "dynamic-sql": " — viết DDL tường minh trong addSql thay cho EXECUTE/format()",
};

/**
 * Ngoại lệ đã duyệt cho migration CHƯA có trên ref gốc mà vi phạm luật nhưng không sửa được (đã commit/áp ở môi trường
 * dev/CI — thêm cờ contract cũng là sửa byte). Mỗi mục { file, rule, reason ≥ 20 ký tự }. Mục không khớp vi phạm nào
 * của file đang kiểm → lỗi (không để allowlist mục nát); file đã lên ref gốc (được miễn) → chỉ nhắc xoá mục.
 */
export const ALLOW = [
  {
    file: "apps/backend/src/modules/settlement/migrations/Migration20261026220000.ts",
    rule: "set-not-null",
    reason:
      "T-101: x_settlement_discrepancy.actual_amount — mọi đường ghi của SettlementModuleService ở bản N−1 (origin/master: ghi row.amount hoặc 0) đã luôn có số, nên bản N−1 chạy được trên schema mới; up() đếm dòng NULL và dừng nếu còn (không tự điền). Commit trước khi có luật T-102.",
  },
];
const MIN_ALLOW_REASON = 20;

const requireHere = createRequire(import.meta.url);
let tsLib;
const typescript = () => (tsLib ??= requireHere("typescript"));

/* ------------------------------------------------------------------ git ------------------------------------------ */

function git(root, args, input) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** true nếu `ref` trỏ tới một commit trong repo. */
export function refExists(root, ref) {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Map đường dẫn → blob hash của mọi file migration trên `ref`. */
export function baseMigrations(root, ref) {
  const out = new Map();
  const raw = git(root, ["ls-tree", "-r", "-z", "--full-tree", ref, "--", MODULES_DIR]);
  for (const entry of raw.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (m && MIGRATION_FILE.test(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

/** Blob hash (đã qua bộ lọc clean của git) của các file trong cây làm việc; file không còn → undefined. */
export function worktreeHashes(root, paths) {
  const present = paths.filter((p) => existsSync(join(root, p)));
  const hashes = present.length
    ? git(root, ["hash-object", "--stdin-paths"], present.join("\n") + "\n")
        .trim()
        .split("\n")
    : [];
  return new Map(present.map((p, i) => [p, hashes[i]]));
}

/** Mục 1: file migration trên base bị sửa/xoá. Trả [{ file, kind: "modified"|"deleted" }]. */
export function checkImmutable(base, current) {
  const out = [];
  for (const [file, sha] of base) {
    const now = current.get(file);
    if (now === undefined) out.push({ file, kind: "deleted" });
    else if (now !== sha) out.push({ file, kind: "modified" });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/* ------------------------------------------------------- lấy SQL thật của up() ---------------------------------- */

class Unanalyzable extends Error {}

/** `Migration` giả: chỉ ghi lại chuỗi SQL; mọi đường khác (knex, execute, EM) là "không phân tích được". */
class FakeMigration {
  constructor() {
    Object.defineProperty(this, "__sql", { value: [], enumerable: false });
  }
  addSql(sql) {
    if (typeof sql !== "string")
      throw new Unanalyzable(
        `addSql nhận ${sql === null ? "null" : typeof sql} (knex builder?), không phải chuỗi`,
      );
    this.__sql.push(sql);
  }
  getKnex() {
    throw new Unanalyzable("getKnex()/knex schema builder");
  }
  getEntityManager() {
    throw new Unanalyzable("getEntityManager()");
  }
  execute() {
    throw new Unanalyzable("execute() chạy SQL trực tiếp");
  }
}

const withTimeout = (p, ms) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`up() quá ${ms} ms`)), ms).unref()),
  ]);

/** Chạy `up()` của migration (mã TS) với Migration giả. Trả { sql: string[] } hoặc { error }. */
export async function extractUpSql(src, fileName = "migration.ts") {
  const ts = typescript();
  let code;
  try {
    code = ts.transpileModule(src, {
      fileName,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  } catch (e) {
    return { error: `không transpile được: ${e.message}` };
  }
  const mod = { exports: {} };
  const req = (id) => {
    if (id === MIGRATION_MODULE) return { Migration: FakeMigration };
    throw new Unanalyzable(`import "${id}" — migration chỉ được import "${MIGRATION_MODULE}"`);
  };
  try {
    vm.runInNewContext(
      code,
      { module: mod, exports: mod.exports, require: req },
      { filename: fileName, timeout: 2000 },
    );
    const classes = Object.values(mod.exports).filter(
      (v) => typeof v === "function" && v.prototype instanceof FakeMigration,
    );
    if (classes.length !== 1)
      return { error: `cần đúng một class \`extends Migration\` được export (thấy ${classes.length})` };
    const inst = new classes[0]();
    if (typeof inst.up !== "function") return { error: "không tìm thấy `up()`" };
    await withTimeout(Promise.resolve(inst.up()), 5000);
    return { sql: [...inst.__sql] };
  } catch (e) {
    return { error: e instanceof Unanalyzable ? e.message : `up() lỗi khi trích SQL: ${e.message}` };
  }
}

/** Nội dung mọi chú thích TS của file (AST — chuỗi, template, regex không tính). */
export function tsComments(src) {
  const ts = typescript();
  const sf = ts.createSourceFile("m.ts", src, ts.ScriptTarget.Latest, true);
  const seen = new Map();
  const add = (ranges) => {
    for (const r of ranges ?? []) seen.set(r.pos, src.slice(r.pos, r.end));
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(src, node.pos));
    add(ts.getTrailingCommentRanges(src, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos));
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
}

/* ----------------------------------------------------------- chuẩn hoá SQL -------------------------------------- */

/**
 * Chuẩn hoá SQL để so luật: bỏ chú thích SQL (`--`, `/* *\/`), thay chuỗi '…' (kể cả E'…' có thoát `\`) bằng '',
 * định danh "…" thay bằng token `⟦<n>⟧` (tên trong `idents`), chữ thường, gộp khoảng trắng. Thân `$$…$$` (DO/hàm)
 * giữ nguyên để quét lệnh bên trong.
 */
export function normalizeSql(sql) {
  const idents = [];
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && d === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      out += " ";
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      while (i < n) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      let j = i + 1;
      let name = "";
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          name += '"';
          j += 2;
        } else if (sql[j] === '"') break;
        else name += sql[j++];
      }
      i = j + 1;
      out += ` ⟦${idents.length}⟧ `;
      idents.push(name.toLowerCase());
    } else {
      out += c;
      i++;
    }
  }
  return { text: out.toLowerCase().replace(/\s+/g, " ").trim(), idents };
}

const NAME_PART = String.raw`(?:⟦\d+⟧|[a-z_$][\w$]*|\$\{[^}]*\})`;
const NAME = String.raw`${NAME_PART}(?:\s*\.\s*${NAME_PART})*`;
const NAMES = String.raw`${NAME}(?:\s*,\s*${NAME})*`;
const RE = (s) => new RegExp(s);
const ALTER_TABLE = RE(String.raw`\balter table (?:if exists )?(?:only )?(${NAME})\s*\*?\s*(.*)$`);
const CREATE_TABLE = RE(
  String.raw`\bcreate (?:(?:global |local )?(?:temporary |temp |unlogged ))?table (?:if not exists )?(${NAME})\s*(\(.*)?$`,
);
const CREATE_INDEX = RE(
  String.raw`\bcreate (?:unique )?index (?:concurrently )?(?:if not exists )?(${NAME}) on\b`,
);
const CREATE_OBJECT = RE(
  String.raw`\bcreate (?:or replace )?(?:materialized view|view|type|sequence|schema)(?: if not exists)? (${NAME})`,
);
const DROP_TABLE = RE(String.raw`\bdrop table (?:if exists )?(${NAMES})`);
const DROP_INDEX = RE(String.raw`\bdrop index (?:concurrently )?(?:if exists )?(${NAMES})`);
const DROP_OBJECT = RE(
  String.raw`\bdrop (materialized view|view|type|sequence|schema) (?:if exists )?(${NAMES})`,
);
const TRUNCATE = RE(String.raw`\btruncate (?:table )?(?:only )?(${NAMES})`);
const ADD_COLUMN = RE(String.raw`^add (?:column )?(?:if not exists )?(${NAME})(.*)$`);
const ADD_NOT_COLUMN = /^(constraint|primary|unique|check|foreign|exclude)$/;
const TABLE_ITEM_NOT_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|like)$/;

/** Tên đã chuẩn hoá (phần cuối, bỏ token định danh) để so bảng/cột/ràng buộc. */
function nameOf(raw, idents) {
  const parts = raw.split(/\s*\.\s*/).map((p) => p.trim());
  const last = parts[parts.length - 1];
  const m = /^⟦(\d+)⟧$/.exec(last);
  return m ? idents[Number(m[1])] : last;
}
const namesOf = (raw, idents) => splitTop(raw).map((t) => nameOf(t, idents));

/** Tách theo dấu phẩy ở mức ngoặc ngoài cùng. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Nội dung trong cặp ngoặc đầu tiên của `s` (bắt đầu bằng "("). */
function parenBody(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(1, i);
  }
  return s.slice(1);
}

const pretty = (s) =>
  s
    .replace(/ ?⟦(\d+)⟧ ?/g, ' "…" ')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

/** Mỗi câu lệnh (theo thứ tự) kèm định danh và đoạn SQL gốc. */
function parseStatements(chunks) {
  const out = [];
  for (const raw of chunks) {
    const { text, idents } = normalizeSql(raw);
    for (const stmt of text.split(";")) if (stmt.trim()) out.push({ stmt: stmt.trim(), idents, raw });
  }
  return out;
}

/** Cột + ràng buộc khai trong thân `create table (…)`. */
function tableItems(body, idents) {
  const columns = [];
  const names = [];
  for (const item of splitTop(body)) {
    const m = RE(String.raw`^(${NAME_PART})\s*(.*)$`).exec(item);
    if (!m) continue;
    const head = nameOf(m[1], idents);
    if (m[1] === "constraint") {
      const c = RE(String.raw`^(${NAME_PART})`).exec(m[2]);
      if (c) names.push(nameOf(c[1], idents));
    } else if (!(TABLE_ITEM_NOT_COLUMN.test(m[1]) && !m[1].startsWith("⟦"))) columns.push(head);
  }
  return { columns, names };
}

/** Tên ràng buộc/index/đối tượng mà câu lệnh TẠO. */
function createdNames({ stmt, idents }) {
  const out = [];
  const ix = CREATE_INDEX.exec(stmt);
  if (ix) out.push(nameOf(ix[1], idents));
  const ob = CREATE_OBJECT.exec(stmt);
  if (ob) out.push(nameOf(ob[1], idents));
  const ct = CREATE_TABLE.exec(stmt);
  if (ct?.[2]) out.push(...tableItems(parenBody(ct[2]), idents).names);
  const at = ALTER_TABLE.exec(stmt);
  if (at)
    for (const action of splitTop(at[2])) {
      const c = RE(String.raw`^add constraint (${NAME_PART})`).exec(action);
      if (c) out.push(nameOf(c[1], idents));
    }
  return out;
}

export const emptySchema = () => ({ tables: new Set(), columns: new Set(), names: new Set() });

/** Cộng bảng/cột/tên ràng buộc & index do các đoạn SQL tạo vào `schema` (dựng schema N−1 từ migration trên base). */
export function applySchema(chunks, schema = emptySchema()) {
  for (const s of parseStatements(chunks)) {
    const { stmt, idents } = s;
    for (const n of createdNames(s)) schema.names.add(n);
    const ct = CREATE_TABLE.exec(stmt);
    if (ct) {
      const t = nameOf(ct[1], idents);
      schema.tables.add(t);
      if (ct[2])
        for (const c of tableItems(parenBody(ct[2]), idents).columns) schema.columns.add(`${t}.${c}`);
    }
    const at = ALTER_TABLE.exec(stmt);
    if (!at) continue;
    const t = nameOf(at[1], idents);
    for (const action of splitTop(at[2])) {
      const add = ADD_COLUMN.exec(action);
      if (add && !ADD_NOT_COLUMN.test(add[1])) schema.columns.add(`${t}.${nameOf(add[1], idents)}`);
    }
  }
  return schema;
}

/** `delete from …` không có WHERE ở mức ngoài cùng, hoặc WHERE hiển nhiên đúng (true, 1=1). */
function deleteWithoutWhere(stmt) {
  const at = stmt.search(/\bdelete from\b/);
  if (at < 0) return false;
  const s = stmt.slice(at);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0 && /^\bwhere\b/.test(s.slice(i)) && (i === 0 || /\W/.test(s[i - 1]))) {
      let cond = s
        .slice(i + 5)
        .replace(/\breturning\b.*$/, "")
        .trim();
      while (/^\(.*\)$/.test(cond)) cond = cond.slice(1, -1).trim();
      return /^(true|1 ?= ?1|'' ?= ?'')?$/.test(cond);
    }
  }
  return true;
}

const DDL_WORD = /\b(drop|alter|truncate|delete|rename)\b/i;

/**
 * Phát hiện thao tác phá huỷ/không phân tích được trong các đoạn SQL của `up()` (theo thứ tự), so với schema N−1
 * `base`. Trả [{ rule, sql }].
 */
export function destructiveOps(chunks, base = emptySchema()) {
  const sts = parseStatements(chunks);
  const createdAt = new Map();
  sts.forEach((s, i) => {
    for (const n of createdNames(s)) createdAt.set(n, [...(createdAt.get(n) ?? []), i]);
  });
  const recreatedAfter = (name, i) => (createdAt.get(name) ?? []).some((j) => j > i);
  const freshTables = new Set();
  const freshCols = new Map(); // "bảng.cột" → { hasDefault }
  const found = [];
  const seenRaw = new Set();
  sts.forEach(({ stmt, idents, raw }, i) => {
    const hit = (rule) => found.push({ rule, sql: pretty(stmt) });
    const freshTable = (t) => freshTables.has(t);
    const freshCol = (t, c) => freshTable(t) || freshCols.has(`${t}.${c}`);

    if (!seenRaw.has(raw)) {
      seenRaw.add(raw);
      for (const m of raw.matchAll(/\bformat\s*\(\s*[eE]?'((?:[^']|'')*)'/gi))
        if (DDL_WORD.test(m[1])) found.push({ rule: "dynamic-sql", sql: pretty(m[0]) });
    }
    if (/\bexecute\b(?! (?:function|procedure)\b)/.test(stmt)) hit("dynamic-sql");

    const ct = CREATE_TABLE.exec(stmt);
    if (ct) {
      const t = nameOf(ct[1], idents);
      if (!base.tables.has(t)) freshTables.add(t);
    }
    const dt = DROP_TABLE.exec(stmt);
    if (dt && !namesOf(dt[1], idents).every(freshTable)) hit("drop-table");
    const tr = TRUNCATE.exec(stmt);
    if (tr && !namesOf(tr[1], idents).every(freshTable)) hit("truncate");
    if (deleteWithoutWhere(stmt)) hit("delete-without-where");
    const di = DROP_INDEX.exec(stmt);
    if (di && namesOf(di[1], idents).some((n) => base.names.has(n) && !recreatedAfter(n, i)))
      hit("drop-index");
    const dobj = DROP_OBJECT.exec(stmt);
    if (dobj && namesOf(dobj[2], idents).some((n) => !recreatedAfter(n, i))) hit("drop-object");

    const at = ALTER_TABLE.exec(stmt);
    if (!at) return;
    const t = nameOf(at[1], idents);
    const actions = splitTop(at[2]);
    if (actions.length === 0 || actions.every((a) => /^\$\{[^}]*\}$/.test(a))) {
      hit("unanalyzable");
      return;
    }
    for (const action of actions) {
      const add = ADD_COLUMN.exec(action);
      if (add && !ADD_NOT_COLUMN.test(add[1])) {
        const c = nameOf(add[1], idents);
        const def = add[2];
        const required =
          /\bnot null\b|\bprimary key\b/.test(def) &&
          !/\bdefault\b|\bgenerated\b|\b(?:small|big)?serial\b/.test(def);
        if (required && !freshTable(t)) hit("add-required-column");
        if (!freshTable(t) && base.tables.has(t) && !base.columns.has(`${t}.${c}`))
          freshCols.set(`${t}.${c}`, { hasDefault: /\bdefault\b/.test(def) });
        continue;
      }
      if (/^rename to\b|^set schema\b/.test(action)) {
        if (!freshTable(t)) hit("rename-table");
        continue;
      }
      if (/^rename constraint\b/.test(action)) continue;
      const rn = RE(String.raw`^rename (?:column )?(${NAME}) to\b`).exec(action);
      if (rn) {
        if (!freshCol(t, nameOf(rn[1], idents))) hit("rename-column");
        continue;
      }
      const dc = RE(String.raw`^drop constraint (?:if exists )?(${NAME_PART})`).exec(action);
      if (dc) {
        const n = nameOf(dc[1], idents);
        if (base.names.has(n) && !recreatedAfter(n, i)) hit("drop-constraint");
        continue;
      }
      if (/^drop constraint\b/.test(action)) continue;
      const dcol = RE(String.raw`^drop (?:column )?(?:if exists )?(${NAME_PART})`).exec(action);
      if (dcol) {
        if (!freshCol(t, nameOf(dcol[1], idents))) hit("drop-column");
        continue;
      }
      const alt = RE(String.raw`^alter (?:column )?(${NAME_PART}) (.*)$`).exec(action);
      if (!alt) continue;
      const c = nameOf(alt[1], idents);
      if (/^(?:set data )?type\b/.test(alt[2]) && !freshCol(t, c)) hit("alter-column-type");
      else if (/^set not null\b/.test(alt[2]) && !(freshTable(t) || freshCols.get(`${t}.${c}`)?.hasDefault))
        hit("set-not-null");
    }
  });
  return found;
}

/** Cờ contract trong CHÚ THÍCH TS. Trả null hoặc { reason, expands: [tên Migration…] }. */
export function contractFlag(src) {
  for (const comment of tsComments(src)) {
    const m = CONTRACT_FLAG.exec(comment);
    if (!m) continue;
    const reason = m[1].replace(/\*\/.*$/, "").trim();
    return { reason, expands: [...new Set(reason.match(MIGRATION_NAME) ?? [])] };
  }
  return null;
}

/**
 * Mục 2 cho một file. ctx: { name (tên migration của file), knownBase (tên migration trên base), earlier (tên migration
 * trong cây làm việc), baseSchema, allowRules }. Trả { errors, ops, allowed, contract }.
 */
export async function checkExpandContract(src, ctx = {}) {
  const name = ctx.name ?? "";
  const knownBase = ctx.knownBase ?? new Set();
  const earlier = ctx.earlier ?? new Set();
  const allowRules = ctx.allowRules ?? new Set();
  const errors = [];
  const extracted = await extractUpSql(src, ctx.file ?? "migration.ts");
  const all = extracted.error
    ? [{ rule: "unanalyzable", sql: extracted.error }]
    : destructiveOps(extracted.sql, ctx.baseSchema ?? emptySchema());
  const ops = all.filter((op) => !allowRules.has(op.rule));
  const allowed = [...new Set(all.filter((op) => allowRules.has(op.rule)).map((op) => op.rule))];
  const flag = contractFlag(src);
  if (flag) {
    if (flag.reason.length < MIN_REASON)
      errors.push(
        `cờ @migration-contract thiếu lý do (≥ ${MIN_REASON} ký tự, nêu migration expand đã phát hành)`,
      );
    else if (flag.expands.length === 0)
      errors.push("cờ @migration-contract phải nêu migration expand trước đó (vd Migration20261027100000)");
    else {
      const ok = (n) => knownBase.has(n) || (n !== name && n < name && earlier.has(n));
      const missing = flag.expands.filter((n) => !ok(n));
      if (missing.length)
        errors.push(
          `cờ @migration-contract nêu ${missing.join(", ")} nhưng migration đó không có trên ref gốc, cũng không phải migration sắp trước file này trong nhánh`,
        );
    }
  }
  const flagOk = flag && errors.length === 0;
  for (const op of ops) {
    if (flagOk && !NOT_CONTRACTABLE.has(op.rule)) continue;
    const why = NOT_CONTRACTABLE.has(op.rule) ? "không phân tích được SQL" : "không có cờ contract hợp lệ";
    errors.push(`${op.rule} trong up() ${why}: ${op.sql}${HINT[op.rule] ?? ""}`);
  }
  return { errors, ops, allowed, contract: Boolean(flag) };
}

/* ------------------------------------------------------------- main ------------------------------------------- */

/** Mọi file migration trong cây làm việc (đường dẫn tương đối, dấu `/`). */
export function listMigrations(root) {
  const out = [];
  let mods;
  try {
    mods = readdirSync(join(root, MODULES_DIR), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const mod of mods) {
    const dir = `${MODULES_DIR}/${mod.name}/migrations`;
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir))) {
      const p = `${dir}/${f}`;
      if (MIGRATION_FILE.test(p)) out.push(p);
    }
  }
  return out.sort();
}

function parseArgs(argv, env) {
  const opts = {
    base: env.MIGRATIONS_BASE_REF || DEFAULT_BASE,
    all: false,
    drift: false,
    keepGenerated: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a.startsWith("--base=")) opts.base = a.slice(7);
    else if (a === "--all") opts.all = true;
    else if (a === "--drift") opts.drift = true;
    else if (a === "--keep-generated") opts.keepGenerated = true;
    else throw new Error(`tham số lạ: ${a}`);
  }
  if (!opts.base) throw new Error("--base cần một ref");
  return opts;
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

/** Mục 1 + 2. */
export async function checkStatic(root, opts, log = console) {
  if (!refExists(root, opts.base)) {
    log.error(
      `check-migrations: ref gốc "${opts.base}" không có trong repo (clone nông/chưa fetch?) — chạy \`git fetch origin <nhánh>\` (CI: actions/checkout với fetch-depth: 0) hoặc truyền --base <ref>.`,
    );
    return 2;
  }
  let base;
  let files;
  let current;
  const baseSql = new Map(); // tên migration trên base → SQL up() (bỏ qua file trích lỗi)
  try {
    base = baseMigrations(root, opts.base);
    files = listMigrations(root);
    current = worktreeHashes(root, [...new Set([...base.keys(), ...files])]);
    for (const [f, sha] of base) {
      const r = await extractUpSql(git(root, ["cat-file", "blob", sha]), f);
      if (r.sql) baseSql.set(baseName(f), r.sql);
    }
  } catch (e) {
    log.error(`check-migrations: không đọc được đầu vào: ${e.message}`);
    return 2;
  }
  let bad = 0;
  for (const v of checkImmutable(base, current)) {
    bad++;
    log.error(
      `check-migrations: ${v.file}: migration đã có trên ${opts.base} bị ${v.kind === "deleted" ? "xoá/di chuyển" : "sửa"} — migration đã áp là bất biến (DB-MIG-003); sửa tiến bằng migration MỚI.`,
    );
  }
  const knownBase = new Set([...base.keys()].map(baseName));
  const earlier = new Set(files.map(baseName));
  const targets = files.filter((f) => opts.all || !base.has(f));
  const allow = opts.allow ?? ALLOW;
  const usedAllow = new Set();
  allow.forEach((a, i) => {
    if (!a || typeof a.file !== "string" || typeof a.rule !== "string") {
      bad++;
      log.error(`check-migrations: ALLOW[${i}]: thiếu file/rule`);
    } else if (typeof a.reason !== "string" || a.reason.trim().length < MIN_ALLOW_REASON) {
      bad++;
      log.error(`check-migrations: ALLOW[${i}] (${a.file}): thiếu lý do (≥ ${MIN_ALLOW_REASON} ký tự)`);
    }
  });
  const schemaCache = new Map();
  /** Schema N−1 cho `name`: migration mới → mọi migration trên base; migration trên base (--all) → các bản trước nó. */
  const schemaFor = (name, onBase) => {
    const key = onBase ? name : "*";
    if (!schemaCache.has(key)) {
      const s = emptySchema();
      for (const [n, sql] of [...baseSql].sort((a, b) => a[0].localeCompare(b[0])))
        if (!onBase || n < name) applySchema(sql, s);
      schemaCache.set(key, s);
    }
    return schemaCache.get(key);
  };
  let contracts = 0;
  for (const f of targets) {
    const name = baseName(f);
    const rules = new Set(allow.filter((a) => a.file === f).map((a) => a.rule));
    const { errors, allowed, contract } = await checkExpandContract(readFileSync(join(root, f), "utf8"), {
      file: f,
      name,
      knownBase,
      earlier,
      baseSchema: schemaFor(name, base.has(f)),
      allowRules: rules,
    });
    if (contract) contracts++;
    for (const r of allowed) usedAllow.add(`${f}#${r}`);
    for (const e of errors) {
      bad++;
      log.error(`check-migrations: ${f}: ${e}`);
    }
  }
  for (const a of allow) {
    if (!a || typeof a.file !== "string" || usedAllow.has(`${a.file}#${a.rule}`)) continue;
    if (targets.includes(a.file) || !files.includes(a.file)) {
      bad++;
      log.error(`check-migrations: ALLOW ${a.file} [${a.rule}] không khớp vi phạm nào — xoá mục nát`);
    } else
      log.log(
        `check-migrations: ALLOW ${a.file} [${a.rule}]: file đã có trên ${opts.base} (được miễn) — xoá mục này`,
      );
  }
  if (bad) {
    log.error(
      "check-migrations: expand/contract (DB-MIG-008, OPS-DEPLOY-003): thêm cột/bảng trước, code ghi cả hai, backfill, chuyển đọc, rồi mới xoá/đổi ở một phát hành SAU — file contract cần chú thích `// @migration-contract: <lý do, nêu MigrationYYYYMMDDHHMMSS expand>`.",
    );
    return 1;
  }
  log.log(
    `check-migrations: ${base.size} migration trên ${opts.base} giữ nguyên byte; ${targets.length} migration ${opts.all ? "(toàn bộ, --all)" : "mới"} đạt expand/contract (${contracts} có cờ contract, ${usedAllow.size} ngoại lệ ALLOW)`,
  );
  return 0;
}

/* ------------------------------------------------------------- drift ------------------------------------------ */

const SAFE_DB = /^xshop_[a-z0-9_]+$/;

/**
 * Tên module Medusa (`Module("<tên>", …)`) của mỗi module tùy biến có model DML (`models/`) và `migrations/`. Module
 * không có model (bảng chỉ do SQL tay tạo, service dùng SQL thô) không có gì để so: db:generate chỉ ghi snapshot rỗng.
 */
export function customModules(root) {
  const out = [];
  const entries = readdirSync(join(root, MODULES_DIR), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of entries) {
    const dir = join(root, MODULES_DIR, e.name);
    if (!e.isDirectory() || !existsSync(join(dir, "migrations")) || !existsSync(join(dir, "models")))
      continue;
    const src = readFileSync(join(root, MODULES_DIR, e.name, "index.ts"), "utf8");
    const call = /\bModule\(\s*(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))/.exec(src);
    let name = call?.[2];
    if (!name && call?.[3]) name = new RegExp(`\\b${call[3]}\\s*=\\s*(["'])([^"']+)\\1`).exec(src)?.[2];
    if (!name)
      throw new Error(`${MODULES_DIR}/${e.name}/index.ts: không đọc được tên module trong Module(…)`);
    out.push({ dir: e.name, name });
  }
  return out;
}

/** Nội dung mọi file trong `migrations/` của các module (để so trước/sau db:generate). */
export function snapshotMigrationDirs(root, mods) {
  const out = new Map();
  for (const { dir } of mods) {
    const d = `${MODULES_DIR}/${dir}/migrations`;
    for (const f of readdirSync(join(root, d))) out.set(`${d}/${f}`, readFileSync(join(root, d, f), "utf8"));
  }
  return out;
}

/** So hai ảnh chụp: [{ file, kind: "added"|"changed"|"removed" }]. */
export function diffSnapshots(before, after) {
  const out = [];
  for (const [f, c] of after) {
    if (!before.has(f)) out.push({ file: f, kind: "added" });
    else if (before.get(f) !== c) out.push({ file: f, kind: "changed" });
  }
  for (const f of before.keys()) if (!after.has(f)) out.push({ file: f, kind: "removed" });
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Đọc output của `medusa db:generate` (utils 2.22.1 bắt lỗi từng module rồi vẫn thoát 0). Trả { failures: [dòng lỗi],
 * done: số module báo "Generated successfully"/"Skipped. No changes detected" }.
 */
export function parseGenerateOutput(output) {
  const failures = [...String(output).matchAll(/Failed with error[^"\n]*/g)].map((m) => m[0].slice(0, 300));
  const done = [...String(output).matchAll(/Generated successfully|Skipped\. No changes detected/g)].length;
  return { failures, done };
}

function runCmd(root, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env } });
    let output = "";
    const sink = (d) => {
      output += d.toString();
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${cmd} ${args.join(" ")} thoát mã ${code ?? signal}\n${output.slice(-4000)}`));
    });
  });
}

async function adminQuery(root, pgBase, sql) {
  const { Client } = createRequire(join(root, "package.json"))("pg");
  const c = new Client({ connectionString: `${pgBase}/postgres` });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/**
 * Mục 3. `deps` cho test thay I/O: { run(cmd,args,opts), admin(sql), env, proc (on/off/exit — tín hiệu) }.
 * An toàn xoá DB: tên kiểm trước mọi lệnh; chỉ DROP khi chính lần chạy đã CREATE thành công; SIGINT/SIGTERM giữa chừng
 * vẫn trả file + xoá DB rồi mới thoát (130/143).
 */
export async function checkDrift(root, opts, deps = {}, log = console) {
  const env = deps.env ?? process.env;
  const proc = deps.proc ?? process;
  const pgBase = env.DRIFT_PG_BASE_URL ?? "postgres://xshop:xshop@localhost:5432";
  const run = deps.run ?? ((cmd, args, o) => runCmd(root, cmd, args, o));
  const admin = deps.admin ?? ((sql) => adminQuery(root, pgBase, sql));
  const dbName = env.DRIFT_DB_NAME ?? `xshop_drift_${randomBytes(6).toString("hex")}`;
  if (!SAFE_DB.test(dbName)) {
    log.error(`check-migrations --drift: DRIFT_DB_NAME phải khớp ${SAFE_DB} (nhận "${dbName}")`);
    return 2;
  }
  let mods;
  let before;
  try {
    mods = customModules(root);
    before = snapshotMigrationDirs(root, mods);
  } catch (e) {
    log.error(`check-migrations --drift: không đọc được module: ${e.message}`);
    return 2;
  }
  const backend = join(root, "apps/backend");
  const medusaEnv = {
    NODE_ENV: "development",
    DATABASE_URL: `${pgBase}/${dbName}`,
    REDIS_URL: "",
    DISABLE_MEDUSA_ADMIN: "true",
  };
  let created = false;
  let cleaning = null;
  const cleanup = () =>
    (cleaning ??= (async () => {
      if (!opts.keepGenerated) {
        // Chỉ trả lại đúng những file chính lần chạy này sinh/đổi (nội dung trước đó đang giữ trong bộ nhớ).
        for (const { file, kind } of diffSnapshots(before, snapshotMigrationDirs(root, mods))) {
          if (kind === "added") rmSync(join(root, file));
          else writeFileSync(join(root, file), before.get(file));
        }
      }
      if (created) {
        try {
          await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        } catch (e) {
          log.error(`check-migrations --drift: không xoá được DB ${dbName} (xoá tay): ${e.message}`);
        }
      }
    })());
  const onSignal = (sig) => {
    log.error(`check-migrations --drift: nhận ${sig} — dọn file sinh ra và DB ${dbName} rồi thoát`);
    cleanup().finally(() => proc.exit(sig === "SIGINT" ? 130 : 143));
  };
  proc.once("SIGINT", onSignal);
  proc.once("SIGTERM", onSignal);
  let drift = [];
  let after = before;
  try {
    await admin(`CREATE DATABASE "${dbName}"`);
    created = true;
    log.log(`check-migrations --drift: DB ${dbName}: build domain + medusa db:migrate…`);
    await run("pnpm", ["--filter", "@x-shop/domain", "build"], {});
    await run("pnpm", ["exec", "medusa", "db:migrate", "--skip-links"], { cwd: backend, env: medusaEnv });
    log.log(`check-migrations --drift: medusa db:generate ${mods.map((m) => m.name).join(" ")}`);
    const output = await run("pnpm", ["exec", "medusa", "db:generate", ...mods.map((m) => m.name)], {
      cwd: backend,
      env: medusaEnv,
    });
    const { failures, done } = parseGenerateOutput(output);
    if (failures.length || done !== mods.length) {
      for (const f of failures) log.error(`check-migrations --drift: ${f}`);
      log.error(
        `check-migrations --drift: LỖI: db:generate thoát 0 nhưng ${failures.length} module lỗi, ${done}/${mods.length} module báo Generated/Skipped — không kết luận được drift`,
      );
      return 2;
    }
    after = snapshotMigrationDirs(root, mods);
    drift = diffSnapshots(before, after);
  } catch (e) {
    log.error(`check-migrations --drift: LỖI: ${e.message}`);
    return 2;
  } finally {
    proc.off("SIGINT", onSignal);
    proc.off("SIGTERM", onSignal);
    await cleanup();
  }
  if (drift.length) {
    for (const d of drift) {
      log.error(`check-migrations --drift: ${d.file} (${d.kind})`);
      if (d.kind === "added") log.error(after.get(d.file));
    }
    log.error(
      "check-migrations --drift: model DML lệch migration/snapshot (DB-MIG-001) — chạy `cd apps/backend && npx medusa db:generate <module>`, soát, rồi commit migration + snapshot.",
    );
    return 1;
  }
  log.log(
    `check-migrations --drift: ${mods.length} module tùy biến, model khớp migration (db:generate không sinh gì)`,
  );
  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  let opts;
  try {
    opts = parseArgs(argv, process.env);
  } catch (e) {
    console.error(`check-migrations: ${e.message}`);
    return 2;
  }
  return opts.drift ? checkDrift(root, opts) : checkStatic(root, opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
