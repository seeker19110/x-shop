#!/usr/bin/env node
// Khoá biến môi trường của schema zod ↔ docs/ops/ENV.md (`node scripts/check-env-doc.mjs`) — T-208, BASE-CFG-003 (Q-18).
//
// `.env.example` không ghi được trong môi trường agent → docs/ops/ENV.md (các khối ```dotenv) là "file tương đương".
// Script so khớp HAI CHIỀU THEO TỪNG APP, không cần biến môi trường thật (phân tích tĩnh văn bản nguồn, không import schema):
//  - khoá schema thiếu ở mục doc của app đó → lỗi (biến chưa được tài liệu hoá);
//  - khoá ở mục doc không có ở schema của app đó → lỗi, trừ khi nằm trong scripts/env-doc-allowlist.json kèm lý do.
// Nguồn schema: khối `z.object({ … })` trong apps/backend/src/lib/env/index.ts (baseSchema) và
// apps/storefront/src/lib/env/index.ts (clientEnvSchema, serverEnvSchema); khoá = tên VIẾT_HOA ở đầu dòng thụt 2 ô.
// Phân tích tĩnh KHÔNG hiểu `...spread`, khoá có nháy, `.extend/.merge/.pick/.omit` → gặp là exit 2 (không đoán). Khoá thực của
// schema được test đơn vị của từng app đối chiếu lại với `--keys-json` (Object.keys(schema.shape)).
// Khoá doc = `KEY=` hoặc `# KEY=` ở đầu dòng trong khối ```dotenv, thuộc mục `## Backend` hoặc `## Storefront` (khối dotenv
// ở mục khác = lỗi).
//
// allowlist: { "backend"|"storefront": { "doc": { "KEY": "lý do" }, "schema": { "KEY": "lý do" } } } — `doc` cho khoá doc
// cố ý không ở schema (biến của Medusa/Next/CI, chỉ test); `schema` cho khoá schema cố ý không tài liệu hoá.
// Mục allowlist không còn dùng → lỗi, để danh sách không mục nát.
// Thoát 0 = khớp; 1 = lệch; 2 = không đọc được đầu vào / cấu trúc nguồn ngoài khả năng phân tích tĩnh.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "[A-Z][A-Z0-9_]*";

/** Khoá của các khối `<name> = z.object({` … `})` (khối kết thúc ở dòng `})` không thụt). Cấu trúc lạ → ném lỗi. */
export function schemaKeys(source, blockNames) {
  const keys = new Set();
  const found = new Set();
  const lines = source.split("\n");
  for (const name of blockNames) {
    if (new RegExp(`\\b${name}\\s*\\.\\s*(extend|merge|pick|omit|safeExtend)\\s*\\(`).test(source))
      throw new Error(`${name}: dùng .extend/.merge/.pick/.omit — ngoài khả năng phân tích tĩnh, sửa script`);
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?const\s+(\w+)\s*=\s*z\.object\(\{\s*$/.exec(lines[i]);
    if (!m || !blockNames.includes(m[1])) continue;
    found.add(m[1]);
    for (let j = i + 1; j < lines.length && !/^\}\)/.test(lines[j]); j++) {
      if (/^ {2}\.\.\./.test(lines[j]))
        throw new Error(`${m[1]}: có spread \`...\` (dòng ${j + 1}) — không phân tích tĩnh được`);
      if (new RegExp(`^ {2}["'\`]${KEY}["'\`]\\s*:`).test(lines[j]))
        throw new Error(`${m[1]}: khoá có nháy (dòng ${j + 1}) — không phân tích tĩnh được`);
      const k = new RegExp(`^ {2}(${KEY}):`).exec(lines[j]);
      if (k) keys.add(k[1]);
    }
  }
  const missing = blockNames.filter((n) => !found.has(n));
  return { keys, missing };
}

/** Khoá khai trong các khối ```dotenv của ENV.md, nhóm theo mục `## Backend` / `## Storefront` (mục khác → `other`). */
export function docKeys(markdown) {
  const sections = { backend: new Set(), storefront: new Set(), other: new Set() };
  let section = "other";
  let inDotenv = false;
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      inFence = !inFence;
      inDotenv = inFence && fence[1] === "dotenv";
      continue;
    }
    if (inFence) {
      if (!inDotenv) continue;
      const m = new RegExp(`^#?\\s?(${KEY})=`).exec(line);
      if (m) sections[section].add(m[1]);
      continue;
    }
    const h = /^##\s+(\S+)/.exec(line);
    if (h) section = h[1] === "Backend" ? "backend" : h[1] === "Storefront" ? "storefront" : "other";
  }
  return sections;
}

/** So khớp hai chiều cho MỘT app; trả về danh sách lỗi (rỗng = đạt). */
export function compare({ app = "app", schema, doc, allowlist = {} }) {
  const docAllow = allowlist.doc ?? {};
  const schemaAllow = allowlist.schema ?? {};
  const errors = [];
  for (const k of [...schema].sort()) {
    if (!doc.has(k) && !(k in schemaAllow))
      errors.push(`[${app}] ${k}: có trong schema zod nhưng thiếu ở mục ${app} của docs/ops/ENV.md`);
  }
  for (const k of [...doc].sort()) {
    if (!schema.has(k) && !(k in docAllow))
      errors.push(
        `[${app}] ${k}: có ở mục ${app} của docs/ops/ENV.md nhưng không có ở schema zod — xoá khỏi doc hoặc thêm vào allowlist kèm lý do`,
      );
  }
  for (const [section, entries] of [
    ["doc", docAllow],
    ["schema", schemaAllow],
  ]) {
    for (const [k, reason] of Object.entries(entries)) {
      const tag = `allowlist.${app}.${section}.${k}`;
      if (typeof reason !== "string" || reason.trim() === "") errors.push(`${tag}: thiếu lý do`);
      else if (section === "doc" && !doc.has(k)) errors.push(`${tag}: không còn ở doc — xoá mục`);
      else if (section === "doc" && schema.has(k)) errors.push(`${tag}: đã có ở schema — xoá mục`);
      else if (section === "schema" && !schema.has(k)) errors.push(`${tag}: không còn ở schema — xoá mục`);
      else if (section === "schema" && doc.has(k)) errors.push(`${tag}: đã có ở doc — xoá mục`);
    }
  }
  return errors;
}

const APPS = {
  backend: [["apps/backend/src/lib/env/index.ts", ["baseSchema"]]],
  storefront: [["apps/storefront/src/lib/env/index.ts", ["clientEnvSchema", "serverEnvSchema"]]],
};

function readSchemas(root) {
  const out = {};
  for (const [app, sources] of Object.entries(APPS)) {
    out[app] = new Set();
    for (const [rel, names] of sources) {
      const abs = join(root, rel);
      if (!existsSync(abs)) throw new Error(`không thấy ${rel}`);
      const { keys, missing } = schemaKeys(readFileSync(abs, "utf8"), names);
      if (missing.length > 0) throw new Error(`${rel}: không tìm thấy khối z.object ${missing.join(", ")}`);
      keys.forEach((k) => out[app].add(k));
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2), io = console) {
  const rootArg = argv.indexOf("--root");
  const root = resolve(
    rootArg >= 0 ? argv[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const docPath = join(root, "docs/ops/ENV.md");
  const allowPath = join(root, "scripts/env-doc-allowlist.json");
  try {
    const schemas = readSchemas(root);
    if (argv.includes("--keys-json")) {
      io.log(
        JSON.stringify({ backend: [...schemas.backend].sort(), storefront: [...schemas.storefront].sort() }),
      );
      return 0;
    }
    if (!existsSync(docPath)) throw new Error("không thấy docs/ops/ENV.md");
    const doc = docKeys(readFileSync(docPath, "utf8"));
    for (const app of Object.keys(APPS))
      if (doc[app].size === 0)
        throw new Error(
          `docs/ops/ENV.md: mục ## ${app === "backend" ? "Backend" : "Storefront"} không có khoá nào trong khối dotenv`,
        );
    const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : {};
    const errors = [];
    for (const k of [...doc.other].sort())
      errors.push(`${k}: khối dotenv nằm ngoài mục "## Backend"/"## Storefront" của docs/ops/ENV.md`);
    for (const app of Object.keys(APPS))
      errors.push(...compare({ app, schema: schemas[app], doc: doc[app], allowlist: allowlist[app] }));
    if (errors.length > 0) {
      io.error(`check-env-doc: ${errors.length} chỗ lệch (BASE-CFG-003):`);
      errors.forEach((e) => io.error(`  - ${e}`));
      return 1;
    }
    io.log(
      `check-env-doc: OK — backend ${schemas.backend.size} khoá, storefront ${schemas.storefront.size} khoá khớp docs/ops/ENV.md`,
    );
    return 0;
  } catch (e) {
    io.error(`check-env-doc: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
