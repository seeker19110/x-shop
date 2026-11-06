#!/usr/bin/env node
// Đối chiếu docs/ROUTES.md với cây apps/storefront/src/app (`node scripts/check-routes.mjs`). FE-RENDER-001.
//  1. Mỗi route thật (page.tsx, route.ts, manifest/robots/sitemap.ts; bỏ test, group `(x)`) phải có đúng một hàng trong bảng.
//  2. Hàng trong bảng mà cây `app/` không có → lỗi. Trùng route → lỗi.
//  3. Chế độ ∈ {tĩnh, cache dùng chung, stream động, CSR}; lý do không rỗng.
// Thoát 0 = đạt; 1 = có lỗi; 2 = không đọc được đầu vào.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MODES = ["tĩnh", "cache dùng chung", "stream động", "CSR"];
const METADATA_ROUTES = {
  "manifest.ts": "/manifest.webmanifest",
  "robots.ts": "/robots.txt",
  "sitemap.ts": "/sitemap.xml",
};
const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js)$/;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Danh sách route thật từ cây `app/` (đã sắp xếp, không trùng). */
export function discoverRoutes(appDir) {
  const routes = new Set();
  for (const file of walk(appDir)) {
    const rel = relative(appDir, file).split(sep);
    const name = rel[rel.length - 1];
    const dirs = rel.slice(0, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    if (ROUTE_FILE.test(name)) routes.add("/" + dirs.join("/"));
    else if (dirs.length === 0 && METADATA_ROUTES[name]) routes.add(METADATA_ROUTES[name]);
  }
  return [...routes].sort();
}

/** Đọc hàng bảng `| \`/route\` | tệp | chế độ | lý do |`. */
export function parseRoutesDoc(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*`(\/[^`]*)`\s*\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim());
    if (cells.length < 3) {
      rows.push({ route: m[1], mode: "", reason: "" });
      continue;
    }
    rows.push({ route: m[1], mode: cells[1].replaceAll("`", ""), reason: cells.slice(2).join("|").trim() });
  }
  return rows;
}

export function validate(routes, rows) {
  const errors = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.route)) errors.push(`route trùng trong bảng: ${r.route}`);
    seen.add(r.route);
    if (!MODES.includes(r.mode))
      errors.push(`${r.route}: chế độ "${r.mode}" không thuộc {${MODES.join(", ")}}`);
    if (!r.reason) errors.push(`${r.route}: thiếu lý do`);
    if (!routes.includes(r.route)) errors.push(`${r.route}: có trong bảng nhưng không có trong app/`);
  }
  for (const route of routes)
    if (!seen.has(route)) errors.push(`${route}: có trong app/ nhưng thiếu trong bảng`);
  return errors;
}

export function main(root) {
  const appDir = join(root, "apps/storefront/src/app");
  let routes;
  let text;
  try {
    routes = discoverRoutes(appDir);
    text = readFileSync(join(root, "docs/ROUTES.md"), "utf8");
  } catch (e) {
    console.error(`check-routes: không đọc được đầu vào: ${e.message}`);
    return 2;
  }
  const rows = parseRoutesDoc(text);
  const errors = validate(routes, rows);
  if (errors.length) {
    for (const e of errors) console.error(`check-routes: ${e}`);
    return 1;
  }
  console.log(`check-routes: ${routes.length} route khớp docs/ROUTES.md`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(join(dirname(fileURLToPath(import.meta.url)), "..")));
}
