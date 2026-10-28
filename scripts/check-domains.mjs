#!/usr/bin/env node
// Kiểm ranh giới miền (ARC-MOD-008, D-047, ADR-0005): tập thư mục cấp một của `apps/backend/src/modules/*` và
// `packages/domain/src/*` phải khớp danh sách khai trong docs/architecture/domains.md.
//  - thư mục chưa khai trong bảng  → lỗi (thêm miền hoặc gán vào miền sẵn có);
//  - tên khai trong bảng mà thư mục không tồn tại → lỗi (bảng mục nát);
//  - thư mục kỹ thuật (không phải miền) nằm trong TECH_DIRS kèm lý do thì được bỏ qua.
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
  __fixtures__: "dữ liệu mẫu cho test",
  shared: "mã kỹ thuật dùng chung giữa các miền, không sở hữu dữ liệu",
  utils: "tiện ích kỹ thuật không gắn miền",
  testing: "helper test",
};

/** Đọc bảng miền → { modules: Set, core: Set }. */
export function parseDomains(text) {
  const modules = new Set();
  const core = new Set();
  let body = false; // chỉ đọc các dòng SAU dòng phân cách `| --- |` (tiêu đề cột cũng có backtick)
  for (const line of (text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim().startsWith("|")) {
      body = false;
      continue;
    }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.length >= 4 && /^[\s:-]+$/.test(cells[2])) {
      body = true;
      continue;
    }
    if (!body || cells.length < 4) continue;
    for (const [idx, set] of [
      [2, modules],
      [3, core],
    ]) {
      for (const m of cells[idx].matchAll(/`([^`]+)`/g)) set.add(m[1]);
    }
  }
  return { modules, core };
}

export function listDirs(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
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

export function check(root, tech = TECH_DIRS) {
  const docPath = join(root, DOMAINS_DOC);
  if (!existsSync(docPath)) throw new Error(`không thấy ${DOMAINS_DOC}`);
  const { modules, core } = parseDomains(readFileSync(docPath, "utf8"));
  return [
    ...compareSet(MODULES_DIR, listDirs(join(root, MODULES_DIR)), modules, tech),
    ...compareSet(CORE_DIR, listDirs(join(root, CORE_DIR)), core, tech),
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
