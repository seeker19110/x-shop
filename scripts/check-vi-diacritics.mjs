#!/usr/bin/env node
// Chuỗi hiển thị tiếng Việt phải có dấu (`node scripts/check-vi-diacritics.mjs`). UX-CONTENT-001.
// Heuristic: quét mã nguồn không phải test (ngoại trừ comment) tìm cụm từ không dấu rất phổ biến của tiếng Việt
// ("dang nhap", "khong", "thanh cong"…). Từ/cụm nằm sau ký tự định danh/đường dẫn (`-`, `_`, `/`, `.`, chữ-số) bị bỏ qua
// nên slug URL ("gio-hang") và identifier không bị tính. Ngoại lệ hợp lệ khai ở scripts/vi-diacritics-allowlist.json
// (mỗi mục: file, contains, reason không rỗng). Thoát 0 = đạt; 1 = có vi phạm / allowlist sai; 2 = không đọc được.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Cụm không dấu phổ biến (chữ thường, không dấu). Nhiều từ trước, một từ rất đặc trưng sau. */
export const UNACCENTED_PHRASES = [
  "dang nhap",
  "dang ky",
  "dang xuat",
  "dang xu ly",
  "dang tinh",
  "dang tai",
  "thanh cong",
  "that bai",
  "tai khoan",
  "mat khau",
  "gio hang",
  "thanh toan",
  "dat hang",
  "don hang",
  "san pham",
  "khach hang",
  "dia chi",
  "so dien thoai",
  "tinh thanh",
  "phuong xa",
  "van chuyen",
  "giao hang",
  "ma giam gia",
  "tong cong",
  "tong tien",
  "tam tinh",
  "tim kiem",
  "danh muc",
  "doi tra",
  "hoan tien",
  "tra cuu",
  "xac nhan",
  "xin chao",
  "cam on",
  "vui long",
  "bat buoc",
  "khong hop le",
  "khong the",
  "khong tim thay",
  "khong co",
  "khong duoc",
  "chua co",
  "da luu",
  "thu lai",
  "quay lai",
  "tiep tuc",
  "xem lai",
  "het hang",
  "con hang",
  "khong",
  "loi",
];

const PHRASE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_\\-/.#:@$\\\\])(${UNACCENTED_PHRASES.map((p) => p.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}_\\-/@=\\\\])`,
  "giu",
);

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|json)$/;
const TEST_FILE = /(\.test\.|\.spec\.|\/__tests__\/|\/fixtures?\/|\.d\.ts$)/;
const SKIP_DIR = new Set(["node_modules", "dist", ".next", ".medusa", "coverage", "migrations"]);

/** Xóa comment dòng và comment khối nhưng giữ nguyên số dòng; không đụng `//` nằm trong chuỗi URL (có `:` đứng trước). */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
    } else if (c === "/" && n === "/" && source[i - 1] !== ":") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Vi phạm trong một file: [{ file, line, phrase, text }]; `allowlist` = [{ file, contains, reason }]. */
export function findViolations(source, file, allowlist = []) {
  const found = [];
  const lines = stripComments(source).split("\n");
  lines.forEach((text, idx) => {
    for (const m of text.matchAll(PHRASE_RE)) {
      const allowed = allowlist.some((a) => a.file === file && text.includes(a.contains));
      if (!allowed) found.push({ file, line: idx + 1, phrase: m[1], text: text.trim() });
    }
  });
  return found;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Kiểm cấu trúc allowlist: mảng, mỗi mục có file/contains/reason là chuỗi không rỗng. Trả danh sách lỗi. */
export function validateAllowlist(list) {
  if (!Array.isArray(list)) return ["allowlist phải là mảng"];
  const errors = [];
  list.forEach((a, i) => {
    for (const k of ["file", "contains", "reason"]) {
      if (typeof a?.[k] !== "string" || a[k].trim() === "")
        errors.push(`allowlist[${i}].${k} phải là chuỗi không rỗng`);
    }
  });
  return errors;
}

export const DEFAULT_ROOTS = ["apps/storefront/src", "apps/backend/src"];

/** Quét các thư mục gốc; trả { violations, errors }. */
export function scan(root, roots = DEFAULT_ROOTS, allowlist = []) {
  const violations = [];
  for (const r of roots) {
    for (const abs of walk(join(root, r))) {
      const rel = relative(root, abs).split(sep).join("/");
      if (!SOURCE_FILE.test(rel) || TEST_FILE.test(`/${rel}`)) continue;
      violations.push(...findViolations(readFileSync(abs, "utf8"), rel, allowlist));
    }
  }
  return violations;
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  let allowlist = [];
  try {
    allowlist = JSON.parse(readFileSync(join(root, "scripts/vi-diacritics-allowlist.json"), "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") {
      console.error(`Không đọc được allowlist: ${e.message}`);
      return 2;
    }
  }
  const bad = validateAllowlist(allowlist);
  if (bad.length > 0) {
    for (const b of bad) console.error(b);
    return 1;
  }
  let violations;
  try {
    violations = scan(root, DEFAULT_ROOTS, allowlist);
  } catch (e) {
    console.error(`Không quét được mã nguồn: ${e.message}`);
    return 2;
  }
  for (const v of violations) console.error(`${v.file}:${v.line}: "${v.phrase}" không dấu — ${v.text}`);
  if (violations.length > 0) {
    console.error(
      `\n${violations.length} chuỗi không dấu (UX-CONTENT-001). Sửa thành tiếng Việt có dấu hoặc khai allowlist có lý do.`,
    );
    return 1;
  }
  console.log("check-vi-diacritics: không có chuỗi tiếng Việt thiếu dấu.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
