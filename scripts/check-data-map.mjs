#!/usr/bin/env node
// Đối chiếu sổ dữ liệu cá nhân với schema thật (`node scripts/check-data-map.mjs`).
//
// Nguồn schema: các `Migration*.ts` dưới apps/backend/src/modules/*/migrations (phần `up()`): `create table` và
// `alter table … add column`. Nguồn khai báo: docs/privacy/data-map.yaml. Kiểm (CMP-PRIV-001, CMP-INTL-002, STD-PRIV-002):
//  1. Mỗi bảng/cột trong migration phải được phân loại trong data-map — là cột PII (`pii:`) hoặc không PII (`non_pii:`),
//     không cả hai. Cột chưa khai báo → lỗi (cột PII mới không thể lọt khỏi sổ). Bảng/cột khai báo mà migration không có → lỗi.
//  2. Mỗi cột PII có đủ: category (basic|sensitive|children), purpose, legal_basis (thuộc tập GDPR Art. 6), retention,
//     recipients (mảng, có thể rỗng), copies. Dữ liệu nhạy cảm (sensitive|children) phải có `art9_basis`.
//  3. docs/compliance/data-inventory.csv khớp ĐÚNG tập cột PII của data-map (hệ thống, bảng, cột, loại, mục đích, cơ sở, thời hạn).
//  4. Mỗi `recipients` trỏ id có trong docs/compliance/vendors.yaml; vendors.yaml có đủ trường bắt buộc.
//  5. Bảng ngoài repo (`external_tables`, bảng của Medusa) chỉ được liệt kê, không đối chiếu máy — in nhắc.
//  6. `retention` của mỗi cột PII là khoá có thật trong `retention_classes` (mỗi lớp có rule/enforced/status).
//  7. Phụ thuộc runtime trông như SDK dịch vụ bên thứ ba (SERVICE_SDK_PATTERNS) phải có dòng `packages` ở vendors.yaml (CMP-AUDIT-007).
//  8. Không có file `.sql/.csv/.json/.dump` > 1 MB, và CSV có tên cột PII ở dòng đầu, trong repo (QA-DATA-001).
//  Cảnh báo (không đổi mã thoát): CHANGELOG privacy quá 183 ngày, vendors.yaml `reviewed_on` quá 12 tháng.
//
// Thoát 0 = đạt; 1 = có lỗi (in từng dòng); 2 = không đọc được đầu vào.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const LEGAL_BASES = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
];
export const PII_CATEGORIES = ["basic", "sensitive", "children"];
export const CSV_HEADER = "system,table,column,category,purpose,legal_basis,retention";
const SKIP_ITEM = /^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i;

/** Cắt chuỗi ở dấu phẩy ngoài ngoặc/nháy. */
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

/** Phần `up()` của một migration (bỏ `down()` — nơi có drop table/column). */
export function upSection(source) {
  const i = source.search(/async\s+down\s*\(/);
  return i === -1 ? source : source.slice(0, i);
}

/** Thân giữa cặp ngoặc bắt đầu ở `open` (chỉ số của "("), tính cả ngoặc lồng và chuỗi trong nháy đơn. */
function balancedBody(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("ngoặc không cân bằng trong câu create table");
}

/** Cột của các bảng được tạo/sửa trong MỘT file migration → Map<bảng, Set<cột>>. */
export function columnsOfMigration(source, into = new Map()) {
  const sql = upSection(source);
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"([a-z0-9_]+)"\s*\(/gi)) {
    const table = m[1];
    const body = balancedBody(sql, m.index + m[0].length - 1);
    const cols = into.get(table) ?? new Set();
    for (const item of splitTopLevel(body)) {
      const t = item.trim();
      if (t === "" || SKIP_ITEM.test(t)) continue;
      const c = /^"([a-z0-9_]+)"\s+\S/i.exec(t);
      if (c) cols.add(c[1]);
    }
    into.set(table, cols);
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?"([a-z0-9_]+)"([^;]*);/gi)) {
    const table = m[1];
    for (const a of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"([a-z0-9_]+)"/gi)) {
      const cols = into.get(table) ?? new Set();
      cols.add(a[1]);
      into.set(table, cols);
    }
  }
  return into;
}

function walkMigrations(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMigrations(p, out);
    else if (/^Migration\d+\.ts$/.test(name)) out.push(p);
  }
  return out.sort();
}

/** Schema từ mọi migration: Map<bảng, Set<cột>>. */
export function schemaFromMigrations(modulesDir) {
  const into = new Map();
  for (const f of walkMigrations(modulesDir)) columnsOfMigration(readFileSync(f, "utf8"), into);
  return into;
}

/** Tách dòng CSV đơn giản có hỗ trợ trường trong nháy kép. */
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const SERVICE_SDK_PATTERNS = [
  /^@aws-sdk\//,
  /^@google-cloud\//,
  /^@azure\//,
  /^(stripe|twilio|nodemailer|resend|postmark|mailgun\.js|mailgun-js|cloudinary|algoliasearch|dd-trace|newrelic|mixpanel|posthog-node|posthog-js|firebase|firebase-admin|@vercel\/analytics|@vercel\/speed-insights)$/,
  /^@(sendgrid|sentry|segment|datadog|algolia|cloudinary|onesignal)\//,
  /^@medusajs\/(file|notification|payment|fulfillment|analytics)-/,
];
export const MAX_DATA_FILE_BYTES = 1024 * 1024;
const DATA_FILE_EXT = /\.(sql|csv|json|dump|sqlite|db)$/i;
const PII_HEADER =
  /(^|[^a-z])(phone|email|address|sdt|so_dien_thoai|ho_ten|fullname|full_name|first_name|last_name|dob|cccd|cmnd)([^a-z]|$)/i;

/** Lỗi SDK dịch vụ chưa có dòng trong vendors.yaml. manifests: [{file, deps: string[]}] */
export function sdkErrors(manifests, vendors) {
  const declared = new Set(
    (vendors?.vendors ?? []).flatMap((v) => (Array.isArray(v?.packages) ? v.packages : [])),
  );
  const errors = [];
  for (const m of manifests) {
    for (const dep of m.deps) {
      if (SERVICE_SDK_PATTERNS.some((re) => re.test(dep)) && !declared.has(dep)) {
        errors.push(
          `${m.file}: phụ thuộc "${dep}" là SDK dịch vụ bên thứ ba nhưng chưa có trong vendors.yaml (trường packages)`,
        );
      }
    }
  }
  return errors;
}

/** Lỗi file dữ liệu: files = [{path, size, firstLine}] (firstLine chỉ cần với .csv). */
export function dataFileErrors(files) {
  const errors = [];
  for (const f of files) {
    if (!DATA_FILE_EXT.test(f.path)) continue;
    if (f.size > MAX_DATA_FILE_BYTES)
      errors.push(`${f.path}: file dữ liệu > 1 MB (${f.size} byte) — cấm dump/export trong repo`);
    if (/\.csv$/i.test(f.path) && PII_HEADER.test(f.firstLine ?? "")) {
      errors.push(`${f.path}: CSV có tên cột PII ở dòng đầu — cấm dữ liệu cá nhân trong repo`);
    }
  }
  return errors;
}

const DAY_MS = 86_400_000;
/** Cảnh báo quá hạn rà soát (không làm đỏ cổng). */
export function reviewWarnings({ vendors, changelogText, today }) {
  const out = [];
  const dates = [...String(changelogText ?? "").matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)].map((m) =>
    Date.parse(m[1] + "T00:00:00Z"),
  );
  if (dates.length === 0) out.push("docs/privacy/CHANGELOG.md không có mục `## YYYY-MM-DD`");
  else if (today.getTime() - Math.max(...dates) > 183 * DAY_MS)
    out.push(
      "docs/privacy/CHANGELOG.md: lần cập nhật gần nhất quá 183 ngày — rà lại sổ dữ liệu theo mốc luật",
    );
  for (const v of vendors?.vendors ?? []) {
    const t = Date.parse(String(v?.reviewed_on) + "T00:00:00Z");
    if (Number.isNaN(t)) out.push(`vendors.yaml: "${v?.id}" có reviewed_on không phải YYYY-MM-DD`);
    else if (today.getTime() - t > 365 * DAY_MS) out.push(`vendors.yaml: "${v?.id}" rà soát quá 12 tháng`);
  }
  return out;
}

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

/** Dòng inventory mong đợi từ data-map: [system, table, column, category, purpose, legal_basis, retention] */
export function inventoryRows(dataMap) {
  const rows = [];
  for (const [table, def] of Object.entries(dataMap.tables ?? {})) {
    for (const [col, p] of Object.entries(def.pii ?? {})) {
      rows.push(
        [def.system, table, col, p.category, p.purpose, p.legal_basis, p.retention].map((x) =>
          String(x ?? ""),
        ),
      );
    }
  }
  return rows;
}

/** Kiểm data-map ↔ schema ↔ inventory ↔ vendors. Trả danh sách lỗi (rỗng = đạt). */
export function validate({ schema, dataMap, inventoryCsv, vendors }) {
  const errors = [];
  const tables = dataMap?.tables ?? {};
  const vendorIds = new Set((vendors?.vendors ?? []).map((v) => v?.id));

  // 1. bảng/cột
  for (const [table, cols] of schema) {
    const def = tables[table];
    if (!def) {
      errors.push(`bảng "${table}" có trong migration nhưng chưa khai báo trong data-map`);
      continue;
    }
    const pii = Object.keys(def.pii ?? {});
    const non = Array.isArray(def.non_pii) ? def.non_pii : [];
    for (const c of cols) {
      const inPii = pii.includes(c);
      const inNon = non.includes(c);
      if (!inPii && !inNon)
        errors.push(`cột "${table}.${c}" chưa được phân loại (pii/non_pii) trong data-map`);
      if (inPii && inNon) errors.push(`cột "${table}.${c}" khai báo cả pii và non_pii`);
    }
    for (const c of [...pii, ...non]) {
      if (!cols.has(c)) errors.push(`data-map khai báo cột "${table}.${c}" nhưng migration không có`);
    }
    if (!isNonEmptyString(def.system)) errors.push(`bảng "${table}" thiếu "system"`);
  }
  for (const table of Object.keys(tables)) {
    if (!schema.has(table)) errors.push(`data-map khai báo bảng "${table}" nhưng migration không có`);
  }

  // 2. trường bắt buộc của cột PII
  for (const [table, def] of Object.entries(tables)) {
    for (const [col, p] of Object.entries(def?.pii ?? {})) {
      const where = `${table}.${col}`;
      if (!PII_CATEGORIES.includes(p?.category))
        errors.push(`${where}: category phải thuộc ${PII_CATEGORIES.join("|")}`);
      if (!isNonEmptyString(p?.purpose)) errors.push(`${where}: thiếu purpose`);
      if (!LEGAL_BASES.includes(p?.legal_basis))
        errors.push(`${where}: legal_basis phải thuộc ${LEGAL_BASES.join("|")}`);
      if (!isNonEmptyString(p?.retention)) errors.push(`${where}: thiếu retention`);
      if (!Array.isArray(p?.recipients)) errors.push(`${where}: recipients phải là mảng (có thể rỗng)`);
      else
        for (const r of p.recipients) {
          if (!vendorIds.has(r))
            errors.push(`${where}: recipients "${r}" không có trong docs/compliance/vendors.yaml`);
        }
      if (!isNonEmptyString(p?.copies))
        errors.push(`${where}: thiếu copies (nơi sao chép; "không" nếu không có)`);
      if ((p?.category === "sensitive" || p?.category === "children") && !isNonEmptyString(p?.art9_basis)) {
        errors.push(`${where}: dữ liệu nhạy cảm/trẻ em phải có art9_basis`);
      }
    }
  }

  // 3. inventory CSV
  const lines = String(inventoryCsv ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines[0] !== CSV_HEADER) errors.push(`data-inventory.csv: dòng đầu phải là "${CSV_HEADER}"`);
  const have = new Map();
  for (const l of lines.slice(1)) {
    const f = parseCsvLine(l);
    if (f.length !== 7) {
      errors.push(`data-inventory.csv: dòng sai số trường (${f.length}≠7): ${l.slice(0, 60)}`);
      continue;
    }
    const key = `${f[1]}.${f[2]}`;
    if (have.has(key)) errors.push(`data-inventory.csv: trùng dòng ${key}`);
    have.set(key, f);
  }
  const want = new Map();
  for (const r of inventoryRows(dataMap)) want.set(`${r[1]}.${r[2]}`, r);
  for (const [key, r] of want) {
    const h = have.get(key);
    if (!h) errors.push(`data-inventory.csv thiếu cột PII ${key}`);
    else if (h.some((v, i) => v !== r[i])) errors.push(`data-inventory.csv: dòng ${key} lệch data-map`);
  }
  for (const key of have.keys()) {
    if (!want.has(key)) errors.push(`data-inventory.csv có ${key} nhưng data-map không khai là PII`);
  }

  // retention classes
  const classes = dataMap?.retention_classes ?? {};
  for (const [id, c] of Object.entries(classes)) {
    for (const k of ["rule", "enforced", "status"]) {
      if (!isNonEmptyString(c?.[k])) errors.push(`retention_classes.${id}: thiếu "${k}"`);
    }
  }
  for (const [table, def] of Object.entries(tables)) {
    for (const [col, p] of Object.entries(def?.pii ?? {})) {
      if (isNonEmptyString(p?.retention) && !(p.retention in classes)) {
        errors.push(`${table}.${col}: retention "${p.retention}" không có trong retention_classes`);
      }
    }
  }
  for (const [name, e] of Object.entries(dataMap?.external_tables ?? {})) {
    if (name.startsWith("_")) continue;
    if (!LEGAL_BASES.includes(e?.legal_basis))
      errors.push(`external_tables.${name}: legal_basis phải thuộc ${LEGAL_BASES.join("|")}`);
    if (!(e?.retention in classes))
      errors.push(`external_tables.${name}: retention "${e?.retention}" không có trong retention_classes`);
    if (!Array.isArray(e?.pii_columns) || e.pii_columns.length === 0)
      errors.push(`external_tables.${name}: thiếu pii_columns`);
    if (!Array.isArray(e?.recipients)) errors.push(`external_tables.${name}: recipients phải là mảng`);
    else
      for (const r of e.recipients)
        if (!vendorIds.has(r))
          errors.push(`external_tables.${name}: recipients "${r}" không có trong vendors.yaml`);
  }

  // 4. vendors
  for (const v of vendors?.vendors ?? []) {
    for (const k of ["id", "service", "data_touched", "location", "dpa", "risk_review", "reviewed_on"]) {
      if (v?.[k] === undefined || v?.[k] === null || v?.[k] === "")
        errors.push(`vendors.yaml: nhà cung cấp "${v?.id}" thiếu "${k}"`);
    }
  }
  return errors;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".medusa", "dist", "coverage", ".turbo"]);

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push({ path: p, size: st.size });
  }
  return out;
}

function readManifests(root) {
  const files = [join(root, "package.json")];
  for (const group of ["apps", "packages"]) {
    for (const d of readdirSync(join(root, group))) {
      const f = join(root, group, d, "package.json");
      try {
        statSync(f);
        files.push(f);
      } catch {
        /* thư mục không có package.json */
      }
    }
  }
  return files.map((f) => {
    const pkg = JSON.parse(readFileSync(f, "utf8"));
    return {
      file: relative(root, f),
      deps: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
    };
  });
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let schema;
  let dataMap;
  let vendors;
  let inventoryCsv;
  let changelogText;
  let manifests;
  let dataFiles;
  try {
    schema = schemaFromMigrations(join(root, "apps/backend/src/modules"));
    dataMap = parse(readFileSync(join(root, "docs/privacy/data-map.yaml"), "utf8"));
    vendors = parse(readFileSync(join(root, "docs/compliance/vendors.yaml"), "utf8"));
    inventoryCsv = readFileSync(join(root, "docs/compliance/data-inventory.csv"), "utf8");
    changelogText = readFileSync(join(root, "docs/privacy/CHANGELOG.md"), "utf8");
    manifests = readManifests(root);
    dataFiles = walkFiles(root)
      .filter((f) => DATA_FILE_EXT.test(f.path))
      .map((f) => ({
        path: relative(root, f.path),
        size: f.size,
        firstLine: /\.csv$/i.test(f.path) ? (readFileSync(f.path, "utf8").split(/\r?\n/, 1)[0] ?? "") : "",
      }));
  } catch (e) {
    console.error(`check-data-map: không đọc được đầu vào: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const errors = [
    ...validate({ schema, dataMap, inventoryCsv, vendors }),
    ...sdkErrors(manifests, vendors),
    ...dataFileErrors(dataFiles),
  ];
  for (const w of reviewWarnings({ vendors, changelogText, today: new Date() }))
    console.warn(`CẢNH BÁO: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`LỖI: ${e}`);
    console.error(`check-data-map: ${errors.length} lỗi`);
    process.exit(1);
  }
  const piiCols = inventoryRows(dataMap).length;
  const ext = Object.keys(dataMap.external_tables ?? {}).filter((k) => !k.startsWith("_")).length;
  console.log(
    `check-data-map: đạt — ${schema.size} bảng, ${piiCols} cột PII khớp inventory; ${dataFiles.length} file dữ liệu đã quét; ${ext} bảng ngoài repo (Medusa) chỉ liệt kê, không đối chiếu máy`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
