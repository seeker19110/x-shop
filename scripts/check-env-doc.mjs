#!/usr/bin/env node
// Khoá biến môi trường của schema zod ↔ docs/ops/ENV.md (`node scripts/check-env-doc.mjs`) — T-208, BASE-CFG-003 (Q-18).
//
// `.env.example` không ghi được trong môi trường agent → docs/ops/ENV.md (các khối ```dotenv) là "file tương đương".
// Script so khớp HAI CHIỀU, không cần biến môi trường thật (phân tích tĩnh văn bản nguồn, không import schema):
//  - khoá schema thiếu ở doc → lỗi (biến chưa được tài liệu hoá);
//  - khoá doc không có ở schema → lỗi, trừ khi nằm trong scripts/env-doc-allowlist.json kèm lý do (biến của Medusa/Next/CI).
// Nguồn schema: khối `z.object({ … })` trong apps/backend/src/lib/env/index.ts (baseSchema) và
// apps/storefront/src/lib/env/index.ts (clientEnvSchema, serverEnvSchema); khoá = tên VIẾT_HOA ở đầu dòng thụt 2 ô.
// Khoá doc = `KEY=` hoặc `# KEY=` ở đầu dòng trong khối ```dotenv.
//
// allowlist: { "doc": { "KEY": "lý do" }, "schema": { "KEY": "lý do" } } — `schema` cho khoá schema cố ý không tài liệu hoá.
// Mục allowlist không còn dùng (khoá không còn ở doc / đã có ở schema) → lỗi, để danh sách không mục nát.
// Thoát 0 = khớp; 1 = lệch; 2 = không đọc được đầu vào / không trích được khoá.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "[A-Z][A-Z0-9_]*";

/** Khoá của các khối `<name> = z.object({` … `});` (khối kết thúc ở dòng `})` không thụt). */
export function schemaKeys(source, blockNames) {
  const keys = new Set();
  const found = new Set();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?const\s+(\w+)\s*=\s*z\.object\(\{\s*$/.exec(lines[i]);
    if (!m || !blockNames.includes(m[1])) continue;
    found.add(m[1]);
    for (let j = i + 1; j < lines.length && !/^\}\)/.test(lines[j]); j++) {
      const k = new RegExp(`^ {2}(${KEY}):`).exec(lines[j]);
      if (k) keys.add(k[1]);
    }
  }
  const missing = blockNames.filter((n) => !found.has(n));
  return { keys, missing };
}

/** Khoá khai trong các khối ```dotenv của ENV.md (dòng `KEY=` hoặc `# KEY=`). */
export function docKeys(markdown) {
  const keys = new Set();
  let inDotenv = false;
  for (const line of markdown.split("\n")) {
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      inDotenv = !inDotenv && fence[1] === "dotenv";
      continue;
    }
    if (!inDotenv) continue;
    const m = new RegExp(`^#?\\s?(${KEY})=`).exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** So khớp hai chiều; trả về danh sách lỗi (rỗng = đạt). */
export function compare({ schema, doc, allowlist = {} }) {
  const docAllow = allowlist.doc ?? {};
  const schemaAllow = allowlist.schema ?? {};
  const errors = [];
  for (const k of [...schema].sort()) {
    if (!doc.has(k) && !(k in schemaAllow))
      errors.push(`${k}: có trong schema zod nhưng thiếu ở docs/ops/ENV.md — thêm vào khối dotenv tương ứng`);
  }
  for (const k of [...doc].sort()) {
    if (!schema.has(k) && !(k in docAllow))
      errors.push(
        `${k}: có trong docs/ops/ENV.md nhưng không có ở schema zod — xoá khỏi doc hoặc thêm vào allowlist kèm lý do`,
      );
  }
  for (const [section, entries] of [
    ["doc", docAllow],
    ["schema", schemaAllow],
  ]) {
    for (const [k, reason] of Object.entries(entries)) {
      if (typeof reason !== "string" || reason.trim() === "")
        errors.push(`allowlist.${section}.${k}: thiếu lý do`);
      else if (section === "doc" && !doc.has(k)) errors.push(`allowlist.doc.${k}: không còn ở doc — xoá mục`);
      else if (section === "doc" && schema.has(k))
        errors.push(`allowlist.doc.${k}: đã có ở schema — xoá mục`);
      else if (section === "schema" && !schema.has(k))
        errors.push(`allowlist.schema.${k}: không còn ở schema — xoá mục`);
      else if (section === "schema" && doc.has(k))
        errors.push(`allowlist.schema.${k}: đã có ở doc — xoá mục`);
    }
  }
  return errors;
}

const SOURCES = [
  ["apps/backend/src/lib/env/index.ts", ["baseSchema"]],
  ["apps/storefront/src/lib/env/index.ts", ["clientEnvSchema", "serverEnvSchema"]],
];

export function main(argv = process.argv.slice(2), io = console) {
  const rootArg = argv.indexOf("--root");
  const root = resolve(
    rootArg >= 0 ? argv[rootArg + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const docPath = join(root, "docs/ops/ENV.md");
  const allowPath = join(root, "scripts/env-doc-allowlist.json");
  try {
    const schema = new Set();
    for (const [rel, names] of SOURCES) {
      const abs = join(root, rel);
      if (!existsSync(abs)) throw new Error(`không thấy ${rel}`);
      const { keys, missing } = schemaKeys(readFileSync(abs, "utf8"), names);
      if (missing.length > 0) throw new Error(`${rel}: không tìm thấy khối z.object ${missing.join(", ")}`);
      keys.forEach((k) => schema.add(k));
    }
    if (!existsSync(docPath)) throw new Error("không thấy docs/ops/ENV.md");
    const doc = docKeys(readFileSync(docPath, "utf8"));
    if (doc.size === 0) throw new Error("docs/ops/ENV.md không có khoá nào trong khối dotenv");
    const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : {};
    const errors = compare({ schema, doc, allowlist });
    if (errors.length > 0) {
      io.error(`check-env-doc: ${errors.length} chỗ lệch (BASE-CFG-003):`);
      errors.forEach((e) => io.error(`  - ${e}`));
      return 1;
    }
    io.log(`check-env-doc: OK — ${schema.size} khoá schema khớp docs/ops/ENV.md (${doc.size} khoá doc)`);
    return 0;
  } catch (e) {
    io.error(`check-env-doc: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
