#!/usr/bin/env node
// Kiểm "component dữ liệu" có đủ test 4 trạng thái (`node scripts/check-ui-states.mjs [gốc]`) — T-206, UX-STATE-001.
//
// "Component dữ liệu" (định nghĩa máy kiểm được): file `.tsx` KHÔNG phải test trong apps/storefront/src/components/**
// mà (a) mở đầu bằng chỉ thị `"use client"` (chú thích đứng trước được bỏ qua) VÀ (b) trong code (đã bỏ chú thích) thỏa
// MỘT trong: gọi `fetch(`/`fetchWithRetry(` (kể cả tiền tố `globalThis.`/`window.`/`self.`); import từ `lib/**/actions`
// (Server Action) hoặc `lib/http/retry`; dùng `useActionState(` hoặc `use(` — tức tự lấy/ghi dữ liệu bất đồng bộ từ trình
// duyệt. Server Component (lấy dữ liệu ở page.tsx) không thuộc phạm vi này — "màn hình" (loading.tsx/error.tsx) là việc khác.
//
// Mỗi component dữ liệu `X.tsx` cần test `X.states.test.tsx` (cạnh nó và/hoặc trong `__tests__/`; hợp các file tồn tại)
// có đủ 4 ca, nhận diện bằng tên `it/test("…")` chứa từ khoá (không phân biệt hoa/thường, nguyên từ): `loading`, `empty`,
// `error`, `success`. Ca chỉ được tính khi THÂN callback có `expect(` và một matcher `.toXxx(` (tên rỗng `it("loading",()=>{})`
// không qua); `.only/.concurrent/.each/.for` tính, `.skip/.skipIf/.todo` không. Giới hạn: không chứng minh assert có ý nghĩa
// (review lo việc đó) và assert phải nằm trực tiếp trong thân ca (helper ngoài thân không tính). Bộ tách chỉ hiểu chuỗi
// '"` và regex literal thông dụng — không phải trình phân tích đầy đủ.
//
// Ngoại lệ: scripts/ui-states-allowlist.json — mảng `{ "file": "<đường dẫn từ gốc>", "reason": "<≥ 20 ký tự>" }`.
// Mục không lý do/lý do quá ngắn → thoát 2; mục trỏ file không còn là component dữ liệu → thoát 1 (không để danh sách mục).
//
// LUẬT MÀN HÌNH (T-226): mỗi `page.tsx` BẤT ĐỒNG BỘ trong apps/storefront/src/app/** (xuất mặc định `async function`/
// `async` arrow, hoặc xuất tên đã khai báo async) cần `loading.tsx` ở chính segment hoặc tổ tiên bất kỳ tới `app/` (route
// group `(x)` cũng là tổ tiên — loading.tsx của group phủ mọi trang con) và `error.tsx` ở segment hoặc tổ tiên tới `app/`
// (`global-error.tsx` KHÔNG thay `error.tsx`). Giới hạn: chỉ nhận diện `async` ở khai báo mặc định (không dò `await` lồng
// trong component đồng bộ — loại đó không hợp lệ ở Server Component); nhận `export { P as default }` và `const P: T = async`,
// KHÔNG nhận bọc HOC (`export default withX(async …)`) — âm tính giả đã biết, tránh dùng mẫu đó cho page. Ngoại lệ màn hình: mục allowlist có thêm
// `"rule": "loading" | "error"` và `file` = đường dẫn page.tsx; mục không còn vi phạm → thoát 1.
//
// Thoát 0 = đạt; 1 = thiếu test/ca hoặc ngoại lệ mục; 2 = đầu vào/allowlist sai.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const COMPONENTS_DIR = "apps/storefront/src/components";
export const ALLOWLIST_FILE = "scripts/ui-states-allowlist.json";
export const MIN_REASON = 20;
export const APP_DIR = "apps/storefront/src/app";
export const STATES = ["loading", "empty", "error", "success"];

// Ký tự cuối (có nghĩa) trước một `/` mà SAU ĐÓ là regex literal chứ không phải phép chia.
const REGEX_PREV = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);
const REGEX_AFTER_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new)$/;

/** Bỏ chú thích dòng và chú thích khối; chuỗi và regex literal được giữ nguyên (chứa `//` không bị cắt). */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let q = null;
  let last = ""; // ký tự có nghĩa gần nhất (không tính khoảng trắng) ngoài chuỗi
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === q) q = null;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*" + "/", i + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (c === "/" && (REGEX_PREV.has(last) || REGEX_AFTER_KEYWORD.test(out.trimEnd().slice(-12)))) {
      // regex literal: chép tới `/` đóng (bỏ qua escape và lớp `[...]`)
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = "/";
    } else {
      if (c === '"' || c === "'" || c === "`") q = c;
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

const FETCH_CALL = /(?<![\w$.])(?:(?:globalThis|window|self)\.)?(?:fetch|fetchWithRetry)\s*\(/;
const IMPORT_DATA = /\bfrom\s*(["'])[^"']*\/lib\/(?:[\w-]+\/)*(?:actions|http\/retry)\1/;
const REACT_DATA = /(?<![\w$.])(?:useActionState|use)\s*\(/;

export function isDataComponent(src) {
  const code = stripComments(src);
  if (!/^(["'])use client\1/.test(code.trimStart())) return false;
  return FETCH_CALL.test(code) || IMPORT_DATA.test(code) || REACT_DATA.test(code);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Vị trí `)` khớp với `(` ở `open` (bỏ qua chuỗi); -1 nếu không khớp. */
function matchParen(code, open) {
  let depth = 0;
  let q = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

const SKIP_MODS = new Set(["skip", "skipIf", "todo"]);
const CALL_MODS = new Set(["each", "for", "runIf", "skipIf"]);
const TITLE_RE = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const HAS_ASSERT = /(?<![\w$.])expect(?:\.soft)?\s*\(/;
const HAS_MATCHER = /\.\s*to[A-Z]\w*\s*\(/;

/** Các trạng thái có ca test hợp lệ (tên chứa từ khoá + thân có expect/matcher) trong một file test. */
export function statesIn(src) {
  const code = stripComments(src);
  const found = new Set();
  const head = /(?<![\w$.])(?:it|test)((?:\.\w+)*)\s*\(/g;
  let m;
  while ((m = head.exec(code)) !== null) {
    const mods = m[1].split(".").filter(Boolean);
    if (mods.some((x) => SKIP_MODS.has(x))) continue;
    let open = m.index + m[0].length - 1; // vị trí `(`
    // it.each(bảng)("tên", fn): bỏ nhóm ngoặc đầu, lấy nhóm ngoặc sau
    if (mods.some((x) => CALL_MODS.has(x))) {
      const close = matchParen(code, open);
      if (close < 0) continue;
      const nx = /^\s*\(/.exec(code.slice(close + 1));
      if (!nx) continue;
      open = close + nx[0].length;
    }
    const close = matchParen(code, open);
    if (close < 0) continue;
    const args = code.slice(open + 1, close);
    const t = TITLE_RE.exec(args);
    if (!t) continue;
    const body = args.slice(t[0].length);
    if (!HAS_ASSERT.test(body) || !HAS_MATCHER.test(body)) continue;
    for (const s of STATES) {
      if (new RegExp(`(?<![\\p{L}\\d])${s}(?![\\p{L}\\d])`, "iu").test(t[2])) found.add(s);
    }
  }
  return found;
}

/** page.tsx có hàm xuất mặc định bất đồng bộ (Server Component async)? */
export function isAsyncPage(src) {
  const code = stripComments(src);
  if (/\bexport\s+default\s+async\b/.test(code)) return true;
  const ref =
    /\bexport\s+default\s+(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:;|$|\()/m.exec(code) ??
    /\bexport\s*\{[^}]*?\b([A-Za-z_$][\w$]*)\s+as\s+default\b[^}]*\}/.exec(code);
  if (ref && ref[1] !== "async") {
    const n = ref[1].replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    return new RegExp(
      `\\basync\\s+function\\s+${n}\\b|\\b(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*async\\b`,
    ).test(code);
  }
  return false;
}

/** Luật màn hình: trả `{ problems, pages }`; `allow` = mục allowlist có `rule`. */
function checkScreens(root, files, allow) {
  const prefix = `${APP_DIR}/`;
  const inApp = files.filter((f) => f.startsWith(prefix));
  const has = new Set(inApp);
  const pages = inApp.filter(
    (f) => /(?:^|\/)page\.tsx$/.test(f) && isAsyncPage(readFileSync(join(root, f), "utf8")),
  );
  const covered = (page, name) => {
    let d = dirname(page);
    for (;;) {
      if (has.has(`${d}/${name}.tsx`)) return true;
      if (d === APP_DIR || !d.startsWith(prefix)) return false;
      d = dirname(d);
    }
  };
  const allowed = new Set(allow.map((a) => `${a.file}#${a.rule}`));
  const problems = [];
  const used = new Set();
  for (const pg of pages) {
    for (const name of ["loading", "error"]) {
      if (covered(pg, name)) continue;
      const key = `${pg}#${name}`;
      if (allowed.has(key)) used.add(key);
      else problems.push(`${pg}: page async thiếu ${name}.tsx (ở segment hoặc tổ tiên tới app/)`);
    }
  }
  for (const key of allowed) {
    if (!used.has(key)) {
      const [f, r] = key.split("#");
      problems.push(`${ALLOWLIST_FILE}: "${f}" (rule ${r}) không còn vi phạm — xóa mục`);
    }
  }
  return { problems, pages };
}

export function check(root) {
  const dir = join(root, COMPONENTS_DIR);
  if (!existsSync(dir)) return { code: 2, lines: [`Không thấy ${COMPONENTS_DIR} ở ${root}`] };
  const files = walk(dir).map((p) => relative(root, p).split("\\").join("/"));
  const comps = files.filter(
    (f) =>
      f.endsWith(".tsx") && !/\.test\.tsx$/.test(f) && isDataComponent(readFileSync(join(root, f), "utf8")),
  );

  let allow = [];
  const alPath = join(root, ALLOWLIST_FILE);
  if (existsSync(alPath)) {
    try {
      allow = JSON.parse(readFileSync(alPath, "utf8"));
      if (!Array.isArray(allow)) throw new Error("không phải mảng");
    } catch (e) {
      return { code: 2, lines: [`${ALLOWLIST_FILE} không đọc được: ${e.message}`] };
    }
  }
  const bad = allow.filter(
    (a) => typeof a?.file !== "string" || typeof a.reason !== "string" || a.reason.trim().length < MIN_REASON,
  );
  if (bad.length > 0) {
    return {
      code: 2,
      lines: bad.map((a) => `${ALLOWLIST_FILE}: mục "${a?.file ?? "?"}" thiếu lý do (≥ ${MIN_REASON} ký tự)`),
    };
  }
  const screenAllow = allow.filter((a) => a.rule !== undefined);
  const badRule = screenAllow.filter((a) => a.rule !== "loading" && a.rule !== "error");
  if (badRule.length > 0) {
    return { code: 2, lines: badRule.map((a) => `${ALLOWLIST_FILE}: mục "${a.file}" có rule không hợp lệ`) };
  }
  allow = allow.filter((a) => a.rule === undefined);
  const allowed = new Set(allow.map((a) => a.file));

  const problems = [];
  for (const a of allowed) {
    if (!comps.includes(a))
      problems.push(`${ALLOWLIST_FILE}: "${a}" không còn là component dữ liệu — xóa mục`);
  }
  for (const f of comps) {
    if (allowed.has(f)) continue;
    const base = f.replace(/\.tsx$/, "");
    const d = dirname(f);
    const name = base.slice(d.length + 1);
    const cands = [`${base}.states.test.tsx`, `${d}/__tests__/${name}.states.test.tsx`].filter((c) =>
      files.includes(c),
    );
    if (cands.length === 0) {
      problems.push(`${f}: thiếu ${name}.states.test.tsx (loading/empty/error/success)`);
      continue;
    }
    const have = new Set();
    for (const c of cands) for (const s of statesIn(readFileSync(join(root, c), "utf8"))) have.add(s);
    const miss = STATES.filter((s) => !have.has(s));
    if (miss.length > 0) {
      problems.push(
        `${f}: ${cands.join(" + ")} thiếu ca ${miss.join("/")} (tên chứa từ khoá + thân có expect/matcher)`,
      );
    }
  }
  const appDir = join(root, APP_DIR);
  const appFiles = existsSync(appDir) ? walk(appDir).map((p) => relative(root, p).split("\\").join("/")) : [];
  const screens = checkScreens(root, appFiles, screenAllow);
  problems.push(...screens.problems);
  const lines = [
    ...problems,
    `${comps.length} component dữ liệu, ${screens.pages.length} page async, ${problems.length} vấn đề`,
  ];
  return { code: problems.length > 0 ? 1 : 0, lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? join(here, "..");
  const r = check(root);
  for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l);
  process.exit(r.code);
}
