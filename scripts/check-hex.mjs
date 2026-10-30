#!/usr/bin/env node
// Cấm màu cứng ngoài file token (`node scripts/check-hex.mjs [thư-mục-gốc-src]`) — T-217, UX-DS-002.
//
// Mọi màu của storefront đến từ token CSS (`apps/storefront/src/styles/tokens.css`, nguồn sự thật duy nhất — DESIGN.md).
// Script quét `apps/storefront/src` (ts/tsx/js/jsx/mjs/cjs/css/scss/sass/less/mdx/html) và báo `file:dòng:cột` cho:
//   - mã hex `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`;
//   - hàm màu cứng `rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()` — trừ khi đối số đầu là `var(` (dựng từ token).
// Không bắt nhầm: id/anchor (`href="#main"`, `url(#clip)`, `/trang#faded`, `?x=#abc`), entity HTML (`&#123;`), số thứ tự/mã đơn
// toàn chữ số (`Đơn #1234`; chuỗi `"#111"` hay khai báo CSS `color: #111` vẫn bị bắt), từ dài hơn 8 ký tự hex.
// Quyết định phạm vi (T-217):
//   - Comment ĐƯỢC quét (đơn giản, chặt hơn; tránh bộ tách comment sai với chuỗi chứa `//`). Muốn nhắc màu trong comment thì tả bằng lời.
//   - Bỏ qua: tokens.css, test/spec/stories, `__fixtures__`, `__snapshots__`, node_modules, .next (dữ liệu giả/kiểm thử, không phải giao diện).
//   - Ngoại lệ có lý do: dòng chứa `hex-ok: <lý do ≥ 8 ký tự>` hoặc dòng liền trước chứa nó; hoặc 5 dòng đầu file chứa
//     `hex-ok-file: <lý do>`. Dùng cho nơi KHÔNG đọc được CSS var (manifest, meta theme-color, global-error thay root layout, dữ liệu màu sản phẩm).
// Thoát 0 = sạch; 1 = có vi phạm; 2 = không đọc được thư mục/file.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = "apps/storefront/src";
export const TOKEN_FILE = "styles/tokens.css";
export const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".mdx",
  ".html",
]);
const SKIP_DIRS = new Set(["node_modules", ".next", "__fixtures__", "__snapshots__"]);
const SKIP_FILE = /\.(test|spec|stories)\.[^.]+$/;
const CSS_LIKE = /\.(css|scss|sass|less)$/;
const REASON_MIN = 8;

const HEX = /#([0-9a-fA-F]+)(?![\w-])/g;
const COLOR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(var\()?/gi;
const URL_CTX =
  /(?:\b(?:href|src|to|action|from|id|for|htmlFor|xlink:href)\s*[=:]\s*["'`{(]*|url\(\s*["']?|\]\(\s*)$/i;

function isIgnoredHex(line, index, digits, cssLike) {
  if (![3, 4, 6, 8].includes(digits.length)) return true;
  const before = line.slice(0, index);
  if (/[\w&/?=%.:-]$/.test(before) && !/:\s$/.test(before)) return true; // `&#123;`, `/trang#abc`, `a#b`, `?x=#abc`
  if (
    /(?:^|[^\w])(?:href|src|to|action|from|id|for|htmlFor|xlink:href)\s*[=:]\s*["'`{(]*$/i.test(before) ||
    URL_CTX.test(before)
  )
    return true;
  if (/^\d+$/.test(digits)) {
    const after = line[index + 1 + digits.length];
    const quoted = /["'`]$/.test(before) && /["'`]/.test(after ?? "");
    const decl = cssLike && /:[^;{}]*$/.test(before);
    return !(quoted || decl); // số thứ tự/mã đơn
  }
  return false;
}

/** Trả về [{line, col, text}] (1-based) — vi phạm trong `text` của file `file` (đường dẫn dùng để biết css hay không). */
export function findViolations(text, file = "x.tsx") {
  const lines = String(text).split(/\r?\n/);
  const cssLike = CSS_LIKE.test(file);
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const m = /hex-ok-file:\s*(.*)$/.exec(lines[i]);
    if (m !== null && m[1].trim().length >= REASON_MIN) return [];
  }
  const ok = (i) =>
    [lines[i], lines[i - 1]].some((l) => {
      const m = l === undefined ? null : /hex-ok:\s*(.*)$/.exec(l);
      return m !== null && m[1].replace(/\*\/\s*$|-->\s*$/, "").trim().length >= REASON_MIN;
    });
  const out = [];
  lines.forEach((line, i) => {
    const hits = [];
    for (const m of line.matchAll(HEX)) {
      if (!isIgnoredHex(line, m.index, m[1], cssLike)) hits.push({ col: m.index + 1, text: m[0] });
    }
    for (const m of line.matchAll(COLOR_FN)) {
      if (m[2] === undefined) hits.push({ col: m.index + 1, text: `${m[1]}(` });
    }
    if (hits.length > 0 && !ok(i)) for (const h of hits) out.push({ line: i + 1, ...h });
  });
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

export function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...listFiles(p));
    } else if (EXTENSIONS.has(e.name.slice(e.name.lastIndexOf("."))) && !SKIP_FILE.test(e.name)) out.push(p);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const dir = argv[0] ?? join(root, SRC_DIR);
  let files;
  try {
    files = listFiles(dir);
  } catch (e) {
    console.error(`check-hex: không đọc được ${dir}: ${e.message}`);
    return 2;
  }
  let bad = 0;
  for (const f of files.sort()) {
    const rel = relative(dir, f).split("\\").join("/");
    if (rel === TOKEN_FILE) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`check-hex: không đọc được ${f}: ${e.message}`);
      return 2;
    }
    for (const v of findViolations(text, f)) {
      bad++;
      console.error(
        `${relative(process.cwd(), f)}:${v.line}:${v.col}: màu cứng \`${v.text}\` — dùng biến token (var(--…)) trong ${SRC_DIR}/${TOKEN_FILE} (UX-DS-002)`,
      );
    }
  }
  if (bad > 0) {
    console.error(`check-hex: ${bad} vi phạm`);
    return 1;
  }
  console.log(`check-hex: OK (${files.length} file quét)`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
