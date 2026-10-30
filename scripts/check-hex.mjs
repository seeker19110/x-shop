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
//   - Ngoài phạm vi: `color-mix()`, tên màu (`red`, `white`…), `currentColor` — không phải mã màu cứng.
//   - Ngoại lệ: CHỈ ở scripts/hex-allowlist.json (`{file, pattern, reason ≥ 20 ký tự}`; `file` tương đối so với src, `pattern` là
//     chuỗi con của dòng vi phạm). Mục không còn khớp vi phạm nào → đỏ (không để danh sách mục nát). Dùng cho nơi KHÔNG đọc được
//     CSS var (manifest, meta theme-color, global-error thay root layout, dữ liệu màu sản phẩm).
// Thoát 0 = sạch; 1 = vi phạm / mục allowlist thừa hoặc sai; 2 = không đọc được thư mục/file/allowlist.
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
export const REASON_MIN = 20;
export const ALLOWLIST_FILE = "scripts/hex-allowlist.json";

const HEX = /#([0-9a-fA-F]+)(?![\w-])/g;
const COLOR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(var\()?/gi;
const URL_CTX =
  /(?:\b(?:href|src|to|action|from|id|for|htmlFor|xlink:href)\s*[=:]\s*["'`{(]*|url\(\s*["']?|\]\(\s*)$/i;

function isIgnoredHex(line, index, digits, cssLike) {
  if (![3, 4, 6, 8].includes(digits.length)) return true;
  const before = line.slice(0, index);
  if (/[\w&/?=%.-]$/.test(before)) return true; // `&#123;`, `/trang#abc`, `a#b`, `?x=#abc` (`color:#fff` vẫn bị bắt)
  if (
    /(?:^|[^\w])(?:href|src|to|action|from|id|for|htmlFor|xlink:href)\s*[=:]\s*["'`{(]*$/i.test(before) ||
    URL_CTX.test(before)
  )
    return true;
  if (/^\d+$/.test(digits)) {
    const after = line[index + 1 + digits.length];
    const quoted = /["'`]$/.test(before) && /["'`]/.test(after ?? "");
    const decl =
      (cssLike && /:[^;{}]*$/.test(before)) ||
      /[\w-]:$/.test(before) || // `color:#000` (style="…", cssText, styled) — không dấu cách
      /(?:color|background|border|outline|fill|stroke|shadow)[\w-]*\s*:[^;{}]*$/i.test(before);
    return !(quoted || decl); // số thứ tự/mã đơn
  }
  return false;
}

/** Trả về [{line, col, text}] (1-based) — vi phạm trong `text` của file `file` (đường dẫn dùng để biết css hay không). */
export function findViolations(text, file = "x.tsx") {
  const lines = String(text).split(/\r?\n/);
  const cssLike = CSS_LIKE.test(file);
  const out = [];
  lines.forEach((line, i) => {
    const hits = [];
    for (const m of line.matchAll(HEX)) {
      if (!isIgnoredHex(line, m.index, m[1], cssLike)) hits.push({ col: m.index + 1, text: m[0] });
    }
    for (const m of line.matchAll(COLOR_FN)) {
      if (m[2] === undefined) hits.push({ col: m.index + 1, text: `${m[1]}(` });
    }
    for (const h of hits) out.push({ line: i + 1, ...h, source: line });
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

/** Kiểm cấu trúc allowlist; trả về mảng lỗi (rỗng = hợp lệ). */
export function validateAllowlist(list) {
  if (!Array.isArray(list)) return ["allowlist phải là mảng"];
  const errs = [];
  list.forEach((e, i) => {
    const at = `mục #${i + 1}`;
    if (typeof e?.file !== "string" || e.file === "") errs.push(`${at}: thiếu "file"`);
    if (typeof e?.pattern !== "string" || e.pattern === "") errs.push(`${at}: thiếu "pattern"`);
    if (typeof e?.reason !== "string" || e.reason.trim().length < REASON_MIN)
      errs.push(`${at}: "reason" phải ≥ ${REASON_MIN} ký tự`);
  });
  return errs;
}

export function main(argv = process.argv.slice(2)) {
  const dir = argv[0] ?? join(root, SRC_DIR);
  const allowFile = argv[1] ?? join(root, ALLOWLIST_FILE);
  let allow;
  try {
    allow = JSON.parse(readFileSync(allowFile, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && argv[1] === undefined && argv[0] !== undefined) allow = [];
    else {
      console.error(`check-hex: không đọc được allowlist ${allowFile}: ${e.message}`);
      return 2;
    }
  }
  const errs = validateAllowlist(allow);
  if (errs.length > 0) {
    for (const m of errs) console.error(`check-hex: ${allowFile}: ${m}`);
    return 1;
  }
  let files;
  try {
    files = listFiles(dir);
  } catch (e) {
    console.error(`check-hex: không đọc được ${dir}: ${e.message}`);
    return 2;
  }
  const used = new Set();
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
      const idx = allow.findIndex((e) => e.file === rel && v.source.includes(e.pattern));
      if (idx >= 0) {
        used.add(idx);
        continue;
      }
      bad++;
      console.error(
        `${relative(process.cwd(), f)}:${v.line}:${v.col}: màu cứng \`${v.text}\` — dùng biến token (var(--…)) trong ${SRC_DIR}/${TOKEN_FILE} (UX-DS-002)`,
      );
    }
  }
  allow.forEach((e, i) => {
    if (used.has(i)) return;
    bad++;
    console.error(`check-hex: mục allowlist thừa (không khớp vi phạm nào): ${e.file} / ${e.pattern}`);
  });
  if (bad > 0) {
    console.error(`check-hex: ${bad} vấn đề`);
    return 1;
  }
  console.log(`check-hex: OK (${files.length} file quét, ${allow.length} ngoại lệ)`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
