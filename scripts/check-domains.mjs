#!/usr/bin/env node
// Kiểm ranh giới miền (ARC-MOD-008, D-047, ADR-0005): tập thư mục cấp một của `apps/backend/src/modules/*` và
// `packages/domain/src/*` phải khớp danh sách khai trong docs/architecture/domains.md.
//  - thư mục chưa khai trong bảng  → lỗi (thêm miền hoặc gán vào miền sẵn có);
//  - tên khai trong bảng mà thư mục không tồn tại → lỗi (bảng mục nát);
//  - ở packages/domain/src còn kiểm cả file `*.ts` lẻ cấp một (trừ index.ts, test) — miền mới có thể là một file;
//  - thư mục/file kỹ thuật (không phải miền) nằm trong TECH_DIRS / CORE_FILES kèm lý do thì được bỏ qua.
// Bảng: cột 3 = module backend, cột 4 = lõi thuần; tên là chuỗi trong dấu backtick (`checkout`), ô như "(trong `checkout`)"
// vẫn đọc ra `checkout`. Thoát 0 = đạt; 1 = lệch; 2 = không đọc được đầu vào.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DOMAINS_DOC = "docs/architecture/domains.md";
export const MODULES_DIR = "apps/backend/src/modules";
export const CORE_DIR = "packages/domain/src";

/** Thư mục kỹ thuật, không phải miền: tên → lý do (bắt buộc, không rỗng). */
export const TECH_DIRS = {
  __tests__: "test dùng chung của các module, không chứa logic miền",
};

/** File `*.ts` lẻ ở cấp một của packages/domain/src, không phải miền: tên file → lý do. (`index.ts` và `*.test.ts` luôn bỏ qua.) */
export const CORE_FILES = {
  "units.ts": "tiện ích đơn vị dùng chung của lõi, không sở hữu dữ liệu miền",
  "presence.ts": "tiện ích kiểm giá trị hiện diện (null/rỗng) dùng chung, không sở hữu dữ liệu miền",
  "result.ts": "kiểu Result dùng chung của lõi, không sở hữu dữ liệu miền",
};

/**
 * Đọc bảng miền → { modules: Set, core: Set }. Chỉ đọc bảng có tiêu đề cột chứa "Module backend" và "Lõi thuần"
 * (xác định cột theo tiêu đề); bảng khác bị bỏ qua.
 */
export function parseDomains(text) {
  const modules = new Set();
  const core = new Set();
  let cols = null; // { m, c } của bảng đang đọc; null = bảng không phải bảng miền
  let header = null;
  let inBody = false;
  for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim().startsWith("|")) {
      cols = null;
      header = null;
      inBody = false;
      continue;
    }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.every((c) => /^[\s:-]+$/.test(c))) {
      // dòng phân cách: dòng ngay trước là tiêu đề
      inBody = true;
      const m = header ? header.findIndex((h) => /module backend/i.test(h)) : -1;
      const c = header ? header.findIndex((h) => /lõi thuần/i.test(h)) : -1;
      cols = m >= 0 && c >= 0 ? { m, c } : null;
      continue;
    }
    if (!inBody) {
      header = cells;
      continue;
    }
    if (!cols) continue;
    for (const [idx, set] of [
      [cols.m, modules],
      [cols.c, core],
    ]) {
      for (const x of (cells[idx] ?? "").matchAll(/`([^`]+)`/g)) set.add(x[1]);
    }
  }
  return { modules, core };
}

export function listDirs(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();
}

/** File `*.ts` cấp một, trừ `index.ts` và test (`*.test.ts`, `*.spec.ts`). */
export function listSourceFiles(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isFile())
    .filter((n) => /\.tsx?$/.test(n) && n !== "index.ts" && !/\.(test|spec)\.tsx?$/.test(n))
    .sort();
}

/** So một thư mục với tập đã khai; trả về danh sách lỗi. */
export function compareSet(label, dirs, declared, tech = TECH_DIRS) {
  const errors = [];
  for (const d of dirs) {
    if (declared.has(d)) continue;
    if (Object.prototype.hasOwnProperty.call(tech, d) && String(tech[d]).trim() !== "") continue;
    errors.push(`${label}/${d} chưa khai trong ${DOMAINS_DOC} (thêm miền hoặc gán vào miền sẵn có)`);
  }
  for (const d of [...declared].sort()) {
    if (!dirs.includes(d)) errors.push(`${DOMAINS_DOC} khai \`${d}\` nhưng ${label}/${d} không tồn tại`);
  }
  return errors;
}

export function check(root, tech = TECH_DIRS, coreFiles = CORE_FILES) {
  const docPath = join(root, DOMAINS_DOC);
  if (!existsSync(docPath)) throw new Error(`không thấy ${DOMAINS_DOC}`);
  const { modules, core } = parseDomains(readFileSync(docPath, "utf8"));
  const coreDir = join(root, CORE_DIR);
  return [
    ...compareSet(MODULES_DIR, listDirs(join(root, MODULES_DIR)), modules, tech),
    ...compareSet(CORE_DIR, [...listDirs(coreDir), ...listSourceFiles(coreDir)].sort(), core, {
      ...tech,
      ...coreFiles,
    }),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  let errors;
  try {
    errors = check(root);
  } catch (e) {
    console.error(`check-domains: ${e.message}`);
    process.exit(2);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-domains: ${e}`);
    process.exit(1);
  }
  console.log("check-domains: modules/* và packages/domain/src/* khớp domains.md");
}
