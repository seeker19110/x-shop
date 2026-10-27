#!/usr/bin/env node
// Kiểm migration của module tùy biến (`apps/backend/src/modules/<module>/migrations/Migration*.ts`) — T-102.
//
//   node scripts/check-migrations.mjs [--base <ref>] [--all]   # bất biến + expand/contract (không cần DB)
//   node scripts/check-migrations.mjs --drift [--keep-generated] # drift model ↔ migration (cần Postgres)
//
// 1. BẤT BIẾN (DB-MIG-003): mọi file migration có trên ref gốc (`--base`, biến `MIGRATIONS_BASE_REF`, mặc định
//    `origin/master`; CI truyền base của PR) phải giữ nguyên byte — so blob hash của git (`git ls-tree` trên ref gốc ↔
//    `git hash-object` của cây làm việc, nên sửa chưa commit cũng bị bắt). Sửa hay xoá/di chuyển → đỏ, in tên file. Ref
//    gốc không có (clone nông, chưa fetch) → đỏ (exit 2), không "bỏ qua cho xanh".
// 2. EXPAND/CONTRACT (DB-MIG-008, OPS-DEPLOY-003): chỉ áp cho migration MỚI (chưa có trên ref gốc); migration đã có trên
//    ref gốc được miễn (đã áp ở môi trường chung, mục 1 khoá nội dung) — `--all` áp cả cho chúng để soát (báo cáo).
//    Quét mọi literal chuỗi của file TRỪ thân `down()` (SQL dựng ở hằng/hàm phụ cấp module vẫn bị quét); chú thích TS,
//    chú thích SQL và chuỗi SQL '…' (vd thông điệp `raise exception`) không tính. Cấm:
//      drop-table · drop-column · rename-table · rename-column · alter-column-type · set-not-null · truncate ·
//      delete-without-where
//    Miễn trong cùng file: drop table / đổi kiểu / SET NOT NULL trên bảng vừa `create table` hay cột vừa `add column`
//    (chưa có dữ liệu/code cũ dùng). `drop constraint|index` (mẫu idempotent drop-if-exists rồi tạo lại) không bị chặn.
//    Thao tác phá huỷ chỉ được phép khi file có cờ trong chú thích:
//      // @migration-contract: <lý do ≥ 15 ký tự, nêu migration expand đã phát hành, vd Migration20261027100000>
//    Migration expand được nêu phải có trên ref gốc (đã merge). Cờ thiếu lý do / không nêu expand → đỏ.
//    Không dùng squawk (tra 2026-10-27: squawkhq.com/docs/cli + `npm view squawk-cli@2.70.0`): chỉ lint file .sql/stdin,
//    không đọc SQL nằm trong TS — mà SQL ở đây dựng bằng template/hằng/vòng lặp, phải chạy class migration mới trích được
//    — và cần nhị phân Rust theo nền tảng (optionalDependencies @squawk-cli/*). Luật regex trên literal đủ cho 8 luật trên.
// 3. DRIFT (DB-MIG-001, `--drift`): DB dùng một lần (`xshop_drift_<hex>`, hoặc `DRIFT_DB_NAME` khớp ^xshop_[a-z0-9_]+$)
//    trên `DRIFT_PG_BASE_URL` (mặc định postgres://xshop:xshop@localhost:5432 — dịch vụ cục bộ/CI, không phải bí mật):
//    build domain → `medusa db:migrate --skip-links` → `medusa db:generate <module tùy biến có models/>` (cú pháp
//    `db:generate [modules...]` — @medusajs/cli 2.22.1 dist/create-cli.js). MikroORM so model DML với snapshot
//    `.snapshot-*.json` đi cùng migration → có file mới/đổi trong `migrations/` = drift (đỏ, in nội dung). Sau đó trả các
//    file đó về như trước (trừ `--keep-generated`) và xoá DB do chính lần chạy tạo. Giới hạn: so với snapshot, không với
//    schema DB thật — SQL tay đổi bảng có model mà không sửa model/snapshot thì không bị bắt (`check:schema` soát catalog).
//
// Thoát 0 = đạt; 1 = vi phạm; 2 = không đọc được đầu vào / ref gốc không có / lỗi DB.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokenize } from "./check-sql-safety.mjs";

const MODULES_DIR = "apps/backend/src/modules";
export const MIGRATION_FILE =
  /^apps\/backend\/src\/modules\/[^/]+\/migrations\/Migration[^/]*\.(ts|js|mjs|cjs)$/;
const CONTRACT_FLAG = /@migration-contract:/g;
const MIGRATION_NAME = /\bMigration\d{14}\b/g;
const MIN_REASON = 15;
export const DEFAULT_BASE = "origin/master";

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

/* --------------------------------------------------------- tách SQL khỏi TS ------------------------------------- */

/** Vị trí `{`…`}` (chỉ tính ký tự mã) của thân phương thức `name()` đầu tiên; null nếu không có. */
export function methodBody(src, mask, name) {
  const re = new RegExp(`\\b${name}\\s*\\(\\s*\\)\\s*(?::\\s*Promise\\s*<\\s*void\\s*>\\s*)?\\{`, "g");
  for (const m of src.matchAll(re)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (!mask[i]) continue;
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return [open, i];
    }
    return [open, src.length];
  }
  return null;
}

/** Nội dung literal JS (bỏ dấu nháy, giải mã thoát `\x` đơn giản). */
function literalBody(lit) {
  return lit.text
    .slice(1, lit.text.endsWith(lit.text[0]) && lit.text.length > 1 ? -1 : undefined)
    .replace(/\\(.)/gs, "$1");
}

/**
 * Chuẩn hoá SQL để so luật: bỏ chú thích SQL (`--`, `/* *\/`), thay chuỗi '…' bằng '' (thông điệp không phải lệnh), định
 * danh "…" thay bằng token `⟦<n>⟧` (tên trong `idents`), chữ thường, gộp khoảng trắng. Thân `$$…$$` (DO/hàm)
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
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
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

/** Tách câu lệnh theo `;` (định danh/chuỗi đã được thay nên `;` còn lại là ranh giới lệnh). */
const statements = (text) =>
  text
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

/* ------------------------------------------------------------- luật ------------------------------------------- */

const NAME_PART = String.raw`(?:⟦\d+⟧|[a-z_$][\w$]*|\$\{[^}]*\})`;
const NAME = String.raw`${NAME_PART}(?:\s*\.\s*${NAME_PART})*`;
const ALTER_TABLE = new RegExp(String.raw`\balter table (?:if exists )?(?:only )?(${NAME})\s*\*?\s*(.*)$`);
const CREATE_TABLE = new RegExp(
  String.raw`\bcreate (?:(?:global |local )?(?:temporary |temp |unlogged ))?table (?:if not exists )?(${NAME})`,
);
const DROP_TABLE = new RegExp(String.raw`\bdrop table (?:if exists )?(${NAME}(?:\s*,\s*${NAME})*)`);
const ADD_NOT_COLUMN = /^(constraint|primary|unique|check|foreign|exclude)\b/;

/** Tên đã chuẩn hoá (phần cuối, bỏ token định danh) để so bảng/cột. */
function nameOf(raw, idents) {
  const parts = raw.split(".").map((p) => p.trim());
  const last = parts[parts.length - 1];
  const m = /^⟦(\d+)⟧$/.exec(last);
  return m ? idents[Number(m[1])] : last;
}

/** Tách danh sách hành động của ALTER TABLE theo dấu phẩy ở mức ngoài cùng. */
function splitActions(s) {
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

const pretty = (s) => s.replace(/⟦(\d+)⟧/g, '"…"').slice(0, 160);

/**
 * Phát hiện thao tác phá huỷ trong các đoạn SQL (mỗi đoạn là nội dung một literal). Trả [{ rule, sql }].
 * Miễn: drop table/đổi kiểu/SET NOT NULL trên bảng tạo hoặc cột thêm trong cùng tập đoạn.
 */
export function destructiveOps(chunks) {
  const parsed = [];
  const createdTables = new Set();
  const addedColumns = new Set();
  for (const chunk of chunks) {
    const { text, idents } = normalizeSql(chunk);
    for (const stmt of statements(text)) {
      parsed.push({ stmt, idents });
      const ct = CREATE_TABLE.exec(stmt);
      if (ct) createdTables.add(nameOf(ct[1], idents));
      const at = ALTER_TABLE.exec(stmt);
      if (!at) continue;
      const table = nameOf(at[1], idents);
      for (const action of splitActions(at[2])) {
        const add = new RegExp(String.raw`^add (?:column )?(?:if not exists )?(${NAME})`).exec(action);
        if (add && !ADD_NOT_COLUMN.test(add[1])) addedColumns.add(`${table}.${nameOf(add[1], idents)}`);
      }
    }
  }
  const found = [];
  const fresh = (table, col) => createdTables.has(table) || addedColumns.has(`${table}.${col}`);
  for (const { stmt, idents } of parsed) {
    const hit = (rule) => found.push({ rule, sql: pretty(stmt) });
    const dt = DROP_TABLE.exec(stmt);
    if (dt && !dt[1].split(",").every((t) => createdTables.has(nameOf(t, idents)))) hit("drop-table");
    if (/\btruncate\b/.test(stmt)) hit("truncate");
    if (/\bdelete from\b/.test(stmt) && !/\bwhere\b/.test(stmt.slice(stmt.search(/\bdelete from\b/))))
      hit("delete-without-where");
    const at = ALTER_TABLE.exec(stmt);
    if (!at) continue;
    const table = nameOf(at[1], idents);
    for (const action of splitActions(at[2])) {
      if (/^rename to\b/.test(action)) hit("rename-table");
      else if (/^rename constraint\b/.test(action)) continue;
      else if (new RegExp(String.raw`^rename (?:column )?${NAME} to\b`).test(action)) hit("rename-column");
      else if (/^drop constraint\b/.test(action)) continue;
      else if (/^drop\b/.test(action)) hit("drop-column");
      else {
        const alt = new RegExp(String.raw`^alter (?:column )?(${NAME}) (.*)$`).exec(action);
        if (!alt) continue;
        const col = nameOf(alt[1], idents);
        if (/^(?:set data )?type\b/.test(alt[2]) && !fresh(table, col)) hit("alter-column-type");
        else if (/^set not null\b/.test(alt[2]) && !fresh(table, col)) hit("set-not-null");
      }
    }
  }
  return found;
}

/** Cờ contract trong CHÚ THÍCH (không tính chuỗi). Trả null hoặc { reason, expands: [tên Migration…] }. */
export function contractFlag(src, mask, literals) {
  for (const m of src.matchAll(CONTRACT_FLAG)) {
    if (mask[m.index] || literals.some((l) => m.index >= l.start && m.index < l.end)) continue;
    const eol = src.indexOf("\n", m.index);
    const reason = src
      .slice(m.index + m[0].length, eol < 0 ? undefined : eol)
      .replace(/\*\/.*$/, "")
      .trim();
    return { reason, expands: [...new Set(reason.match(MIGRATION_NAME) ?? [])] };
  }
  return null;
}

/**
 * Mục 2 cho một file. `knownBase` = tên migration (không đuôi) có trên ref gốc. Trả { errors: [string], contract }.
 */
export function checkExpandContract(src, knownBase = new Set(), allowRules = new Set()) {
  const { mask, literals } = tokenize(src);
  const errors = [];
  if (!methodBody(src, mask, "up")) errors.push("không tìm thấy thân `up()`");
  const down = methodBody(src, mask, "down");
  const chunks = literals.filter((l) => !(down && l.start > down[0] && l.end <= down[1])).map(literalBody);
  const all = destructiveOps(chunks);
  const ops = all.filter((op) => !allowRules.has(op.rule));
  const allowed = [...new Set(all.filter((op) => allowRules.has(op.rule)).map((op) => op.rule))];
  const flag = contractFlag(src, mask, literals);
  if (flag) {
    if (flag.reason.length < MIN_REASON)
      errors.push(
        `cờ @migration-contract thiếu lý do (≥ ${MIN_REASON} ký tự, nêu migration expand đã phát hành)`,
      );
    else if (flag.expands.length === 0)
      errors.push("cờ @migration-contract phải nêu migration expand trước đó (vd Migration20261027100000)");
    else {
      const missing = flag.expands.filter((n) => !knownBase.has(n));
      if (missing.length)
        errors.push(
          `cờ @migration-contract nêu ${missing.join(", ")} nhưng migration đó chưa có trên ref gốc (expand phải phát hành trước)`,
        );
    }
  }
  if (ops.length && (!flag || errors.length)) {
    for (const op of ops) errors.push(`${op.rule} trong up() không có cờ contract hợp lệ: ${op.sql}`);
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
export function checkStatic(root, opts, log = console) {
  if (!refExists(root, opts.base)) {
    log.error(
      `check-migrations: ref gốc "${opts.base}" không có trong repo (clone nông/chưa fetch?) — chạy \`git fetch origin <nhánh>\` (CI: actions/checkout với fetch-depth: 0) hoặc truyền --base <ref>.`,
    );
    return 2;
  }
  let base;
  let files;
  let current;
  try {
    base = baseMigrations(root, opts.base);
    files = listMigrations(root);
    current = worktreeHashes(root, [...new Set([...base.keys(), ...files])]);
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
  let contracts = 0;
  for (const f of targets) {
    const rules = new Set(allow.filter((a) => a.file === f).map((a) => a.rule));
    const { errors, allowed, contract } = checkExpandContract(
      readFileSync(join(root, f), "utf8"),
      knownBase,
      rules,
    );
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
      "check-migrations: expand/contract (DB-MIG-008, OPS-DEPLOY-003): thêm cột/bảng trước, code ghi cả hai, backfill, chuyển đọc, rồi mới xoá/đổi ở một phát hành SAU — file contract cần chú thích `// @migration-contract: <lý do, nêu MigrationYYYYMMDDHHMMSS expand đã phát hành>`.",
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
 * Mục 3. `deps` cho test thay I/O: { run(cmd,args,opts), admin(sql), env }.
 * An toàn xoá DB: tên kiểm trước mọi lệnh; chỉ DROP khi chính lần chạy đã CREATE thành công.
 */
export async function checkDrift(root, opts, deps = {}, log = console) {
  const env = deps.env ?? process.env;
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
  let drift = [];
  let after = before;
  try {
    await admin(`CREATE DATABASE "${dbName}"`);
    created = true;
    log.log(`check-migrations --drift: DB ${dbName}: build domain + medusa db:migrate…`);
    await run("pnpm", ["--filter", "@x-shop/domain", "build"], {});
    await run("pnpm", ["exec", "medusa", "db:migrate", "--skip-links"], { cwd: backend, env: medusaEnv });
    log.log(`check-migrations --drift: medusa db:generate ${mods.map((m) => m.name).join(" ")}`);
    await run("pnpm", ["exec", "medusa", "db:generate", ...mods.map((m) => m.name)], {
      cwd: backend,
      env: medusaEnv,
    });
    after = snapshotMigrationDirs(root, mods);
    drift = diffSnapshots(before, after);
  } catch (e) {
    log.error(`check-migrations --drift: LỖI: ${e.message}`);
    return 2;
  } finally {
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
