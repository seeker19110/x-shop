#!/usr/bin/env node
// Lint tên cột số thiếu hậu tố đơn vị (`node scripts/check-units.mjs`) — T-160, XC-UNITS-009 (D-110).
//
// Cột số là cột mà một con số "trần" dễ bị hiểu sai đơn vị (ms hay giây? byte hay KB? đồng hay nghìn đồng?). Quy tắc:
// cột số mà TÊN chỉ một đại lượng có đơn vị — thời lượng (`timeout`, `ttl`, `delay`, `window`…), kích thước/khối lượng
// (`size`, `width`, `weight`…) hay tiền (`amount`, `price`, `fee`, `total`…) — phải kết thúc bằng hậu tố đơn vị
// (`_ms`, `_seconds`, `_minutes`, `_bytes`, `_vnd`, `_cm`, `_grams`, `_percent`, `_bps`…) HOẶC nằm trong
// scripts/units-allowlist.json kèm lý do. Cột đếm (`rows_total`, `attempts`, `trip_count`) không phải đại lượng có đơn vị
// nên không bị bắt. Tên không chứa từ đại lượng nào (rank, version, cart_version…) cũng không bị bắt: lint chặn mẫu đã
// biết dễ nhầm, không đoán nghĩa mọi tên.
//
// Hai nguồn quét (giống nhau về luật):
//  1. MIGRATION: SQL do `up()` của mọi `apps/backend/src/modules/<module>/migrations/Migration*.ts` sinh ra (dùng lại bộ
//     trích SQL thật của scripts/check-migrations.mjs — nối chuỗi/`${…}`/hàm phụ đều thấy đúng), áp theo thứ tự tên file
//     (create table / add column / alter column type / rename column / drop column) để lấy schema CUỐI; chỉ cột kiểu số
//     (smallint/integer/bigint/numeric/decimal/real/double precision/float/serial) được xét. Migration KHÔNG bị sửa:
//     cột đã áp không đổi tên được → ghi vào ngoại lệ.
//  2. MODEL: `model.number()`/`bigNumber()`/`float()`/`autoincrement()` trong
//     `apps/backend/src/modules/<module>/models/*.ts` (AST của typescript, nên chú thích/chuỗi không bị tính).
// Khoá ngoại lệ là `<bảng>.<cột>` với bảng đã bỏ tiền tố `x_` (tên DML của model và tên bảng SQL dùng chung một khoá), hoặc
// `*.<cột>` cho mọi bảng. Mục ngoại lệ không khớp cột nào (đã đổi tên/xoá) → lỗi, để danh sách không mục nát.
//
// Thoát 0 = đạt; 1 = vi phạm / ngoại lệ sai; 2 = không đọc được đầu vào / migration không phân tích được.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractUpSql,
  listMigrations,
  nameOf,
  normalizeSql,
  parenBody,
  splitTop,
} from "./check-migrations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MODULES_DIR = "apps/backend/src/modules";
export const ALLOWLIST_FILE = "scripts/units-allowlist.json";
export const MIN_REASON = 20;

/** Hậu tố đơn vị hợp lệ (token cuối của tên cột). */
export const UNIT_SUFFIXES = new Set([
  // thời lượng
  "ms",
  "us",
  "ns",
  "s",
  "sec",
  "secs",
  "seconds",
  "minutes",
  "mins",
  "hours",
  "days",
  // dung lượng
  "bytes",
  "kb",
  "mb",
  "gb",
  "kib",
  "mib",
  "gib",
  // tiền
  "vnd",
  // độ dài / khối lượng
  "mm",
  "cm",
  "m",
  "km",
  "g",
  "kg",
  "grams",
  // tỷ lệ
  "percent",
  "pct",
  "bps",
  "ratio",
]);

/** Từ trong tên (tách theo `_`) chỉ đại lượng CÓ đơn vị → phải có hậu tố đơn vị. */
export const DIMENSION_WORDS = new Map([
  ...[
    "duration",
    "timeout",
    "ttl",
    "delay",
    "interval",
    "age",
    "lease",
    "window",
    "wait",
    "cooldown",
    "backoff",
    "latency",
    "elapsed",
    "expiry",
    "retention",
    "period",
  ].map((w) => [w, "thời lượng"]),
  ...["size", "length", "width", "height", "depth", "weight", "distance", "capacity"].map((w) => [
    w,
    "kích thước/khối lượng",
  ]),
  ...[
    "amount",
    "price",
    "fee",
    "total",
    "subtotal",
    "cost",
    "balance",
    "tax",
    "discount",
    "refund",
    "cod",
    "charge",
    "payout",
    "threshold",
  ].map((w) => [w, "tiền"]),
]);

/** Danh từ đếm/thứ hạng: tên chứa chúng là số lượng hay thứ tự, không phải đại lượng có đơn vị (`rows_total`, `size_rank`). */
export const COUNT_WORDS = new Set([
  "rows",
  "items",
  "lines",
  "count",
  "counts",
  "attempts",
  "failures",
  "retries",
  "rank",
  "number",
  "num",
]);

const NUMERIC_TYPE =
  /^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float|float4|float8|smallserial|serial|bigserial)\b/;

/** null nếu tên ổn; ngược lại { dimension, word } = đại lượng bị thiếu hậu tố đơn vị. */
export function classifyColumn(name) {
  const tokens = String(name).toLowerCase().split("_").filter(Boolean);
  if (tokens.length === 0) return null;
  if (UNIT_SUFFIXES.has(tokens[tokens.length - 1])) return null;
  if (tokens.some((t) => COUNT_WORDS.has(t))) return null;
  for (const t of tokens) {
    const dimension = DIMENSION_WORDS.get(t);
    if (dimension) return { dimension, word: t };
  }
  return null;
}

/** Bỏ tiền tố `x_` để tên DML của model và tên bảng SQL dùng chung một khoá. */
export const tableKey = (t) => String(t).replace(/^x_/, "");

/* ------------------------------------------------------------------ migration ------------------------------------ */

const NAME_PART = String.raw`(?:⟦\d+⟧|[a-z_$][\w$]*)`;
const NAME = String.raw`${NAME_PART}(?:\s*\.\s*${NAME_PART})*`;
const CREATE_TABLE = new RegExp(
  String.raw`\bcreate (?:(?:global |local )?(?:temporary |temp |unlogged ))?table (?:if not exists )?(${NAME})\s*(\(.*)$`,
);
const ALTER_TABLE = new RegExp(String.raw`\balter table (?:if exists )?(?:only )?(${NAME})\s*\*?\s*(.*)$`);
const NOT_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|like)$/;

/**
 * Áp các đoạn SQL (của một migration) lên `cols` (Map `bảng.cột` → { table, column, type }). Chỉ nhận cột có kiểu số
 * (kiểu khác bỏ; đổi kiểu sang không-số → xoá khỏi map). Bảng/cột dựng bằng `${…}` bị bỏ qua.
 */
export function applyColumns(chunks, cols = new Map()) {
  for (const raw of chunks) {
    const { text, idents } = normalizeSql(raw);
    for (const part of text.split(";")) {
      const stmt = part.trim();
      if (!stmt) continue;
      const ct = CREATE_TABLE.exec(stmt);
      if (ct) {
        const table = nameOf(ct[1], idents);
        for (const item of splitTop(parenBody(ct[2]))) setColumn(cols, table, item, idents);
        continue;
      }
      const at = ALTER_TABLE.exec(stmt);
      if (!at) continue;
      const table = nameOf(at[1], idents);
      for (const action of splitTop(at[2])) {
        let m;
        if ((m = /^add (?:column )?(?:if not exists )?(.*)$/.exec(action)))
          setColumn(cols, table, m[1], idents);
        else if (
          (m = new RegExp(String.raw`^alter (?:column )?(${NAME_PART}) (?:set data )?type (.*)$`).exec(
            action,
          ))
        )
          setColumn(cols, table, `${m[1]} ${m[2]}`, idents);
        else if (
          (m = new RegExp(String.raw`^rename (?:column )?(${NAME_PART}) to (${NAME_PART})$`).exec(action))
        ) {
          const from = `${table}.${nameOf(m[1], idents)}`;
          const old = cols.get(from);
          if (old) {
            cols.delete(from);
            const column = nameOf(m[2], idents);
            cols.set(`${table}.${column}`, { ...old, column });
          }
        } else if ((m = new RegExp(String.raw`^drop (?:column )?(?:if exists )?(${NAME_PART})`).exec(action)))
          cols.delete(`${table}.${nameOf(m[1], idents)}`);
      }
    }
  }
  return cols;
}

/** Một mục `tên kiểu …` của create table / add column / alter type. */
function setColumn(cols, table, item, idents) {
  const m = new RegExp(String.raw`^(${NAME_PART})\s+(.*)$`).exec(item.trim());
  if (!m || (NOT_COLUMN.test(m[1]) && !m[1].startsWith("⟦"))) return;
  const column = nameOf(m[1], idents);
  if (table.includes("$") || column.includes("$")) return;
  const key = `${table}.${column}`;
  if (NUMERIC_TYPE.test(m[2])) cols.set(key, { table, column, type: NUMERIC_TYPE.exec(m[2])[1] });
  else cols.delete(key);
}

/* ------------------------------------------------------------------ model ---------------------------------------- */

const NUMBER_DSL = new Set(["number", "bigNumber", "float", "autoincrement"]);
const requireHere = createRequire(import.meta.url);

/** [{ table (tên DML), column }] của thuộc tính khởi tạo bằng `model.number()`… (kể cả chuỗi `.default().nullable()`). */
export function modelColumns(src, fileName = "model.ts") {
  const ts = requireHere("typescript");
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const out = [];
  const rootCall = (expr) => {
    let e = expr;
    while (e && ts.isCallExpression(e)) {
      const callee = e.expression;
      if (!ts.isPropertyAccessExpression(callee)) return null;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "model") return callee.name.text;
      e = callee.expression;
    }
    return null;
  };
  const defineName = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        p.expression.name.text === "define"
      ) {
        const a = p.arguments[0];
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
        if (a && ts.isObjectLiteralExpression(a)) {
          const t = a.properties.find((x) => x.name?.getText() === "tableName");
          if (t && ts.isPropertyAssignment(t) && ts.isStringLiteralLike(t.initializer))
            return t.initializer.text;
        }
        return "?";
      }
    }
    return "?";
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && NUMBER_DSL.has(rootCall(node.initializer) ?? "")) {
      const n = node.name;
      const column = ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
      if (column) out.push({ table: defineName(node), column });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/* ------------------------------------------------------------------ kiểm ----------------------------------------- */

/**
 * @param {{ migrations: {file: string, sql: string[]}[], models: {file: string, src: string}[], allow: {column: string, reason: string}[] }} input
 * @returns {{ violations: string[], problems: string[] }} violations = cột thiếu hậu tố; problems = ngoại lệ sai/mục nát
 */
export function checkUnits({ migrations, models, allow }) {
  const problems = [];
  const entries = new Map();
  for (const [i, a] of allow.entries()) {
    if (typeof a?.column !== "string" || !/^(\*|[a-z0-9_]+)\.[a-z0-9_]+$/.test(a.column)) {
      problems.push(`allowlist[${i}]: "column" phải dạng "<bảng>.<cột>" hoặc "*.<cột>" (đã bỏ tiền tố x_)`);
      continue;
    }
    if (typeof a.reason !== "string" || a.reason.trim().length < MIN_REASON)
      problems.push(`allowlist[${i}] (${a.column}): thiếu "reason" (≥ ${MIN_REASON} ký tự)`);
    if (entries.has(a.column)) problems.push(`allowlist[${i}] (${a.column}): khoá trùng`);
    entries.set(a.column, { used: false });
  }

  const found = new Map(); // khoá → { where: Set, info }
  const note = (table, column, where) => {
    const info = classifyColumn(column);
    if (!info) return;
    const key = `${tableKey(table)}.${column}`;
    const cur = found.get(key) ?? { where: new Set(), info };
    cur.where.add(where);
    found.set(key, cur);
  };

  const cols = new Map();
  for (const m of migrations) applyColumns(m.sql, cols);
  for (const c of cols.values()) note(c.table, c.column, `migration (${c.type})`);
  for (const m of models)
    for (const c of modelColumns(m.src, m.file)) note(c.table, c.column, `model ${m.file}`);

  const violations = [];
  for (const [key, { where, info }] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    const column = key.slice(key.indexOf(".") + 1);
    const hit = entries.get(key) ?? entries.get(`*.${column}`);
    if (hit) {
      hit.used = true;
      continue;
    }
    violations.push(
      `${key} — cột số chỉ ${info.dimension} ("${info.word}") thiếu hậu tố đơn vị (_ms/_seconds/_bytes/_vnd/…) [${[...where].join("; ")}]`,
    );
  }
  for (const [key, e] of entries)
    if (!e.used) problems.push(`allowlist: "${key}" không khớp cột số nào cần ngoại lệ — xoá mục này`);
  return { violations, problems };
}

/* ------------------------------------------------------------------ CLI ------------------------------------------ */

function listModels(rootDir) {
  const out = [];
  const base = join(rootDir, MODULES_DIR);
  if (!existsSync(base)) return out;
  for (const mod of readdirSync(base, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const dir = join(base, mod.name, "models");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort())
      if (/\.ts$/.test(f) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(f))
        out.push(`${MODULES_DIR}/${mod.name}/models/${f}`);
  }
  return out;
}

export async function main(rootDir = root, log = console) {
  let allow;
  try {
    allow = JSON.parse(readFileSync(join(rootDir, ALLOWLIST_FILE), "utf8"));
    if (!Array.isArray(allow)) throw new Error("phải là mảng");
  } catch (e) {
    log.error(`check-units: không đọc được ${ALLOWLIST_FILE}: ${e.message}`);
    return 2;
  }
  const migrations = [];
  for (const file of listMigrations(rootDir)) {
    const r = await extractUpSql(readFileSync(join(rootDir, file), "utf8"), file);
    if (r.error) {
      log.error(`check-units: không phân tích được ${file}: ${r.error}`);
      return 2;
    }
    migrations.push({ file, sql: r.sql });
  }
  // thứ tự áp = tên file (Migration<UTC timestamp>) xuyên module
  migrations.sort((a, b) => a.file.split("/").pop().localeCompare(b.file.split("/").pop()));
  const models = listModels(rootDir).map((file) => ({
    file,
    src: readFileSync(join(rootDir, file), "utf8"),
  }));
  const { violations, problems } = checkUnits({ migrations, models, allow });
  for (const p of problems) log.error(`check-units: ${p}`);
  for (const v of violations) log.error(`check-units: ${v}`);
  if (violations.length || problems.length) {
    log.error(
      `check-units: ĐỎ — ${violations.length} cột thiếu hậu tố đơn vị, ${problems.length} lỗi ngoại lệ. Đổi tên cột có đơn vị (model mới; ` +
        `cột đã áp thì thêm migration đổi tên expand/contract) hoặc ghi ${ALLOWLIST_FILE} kèm lý do.`,
    );
    return 1;
  }
  log.log(
    `check-units: đạt — ${migrations.length} migration, ${models.length} file model, ${allow.length} ngoại lệ`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main());
