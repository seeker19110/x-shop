#!/usr/bin/env node
// Kiểm "component dữ liệu" có đủ test 4 trạng thái (`node scripts/check-ui-states.mjs [gốc]`) — T-206, UX-STATE-001.
//
// "Component dữ liệu" (định nghĩa máy kiểm được, chặt để ít dương tính giả): file `.tsx` KHÔNG phải test trong
// apps/storefront/src/components/** mà (a) mở đầu bằng chỉ thị `"use client"` VÀ (b) trong code (đã bỏ chú thích) có
// lời gọi `fetch(` hoặc `fetchWithRetry(` — tức tự tải dữ liệu bất đồng bộ từ trình duyệt. Server Component lấy dữ
// liệu ở trang (page.tsx) và Server Action (mutation) không thuộc phạm vi này.
//
// Mỗi component dữ liệu `X.tsx` cần một file test `X.states.test.tsx` (cạnh nó hoặc trong `__tests__/`) có đủ 4 ca,
// nhận diện bằng tên `it/test("…")` chứa từ khoá (không phân biệt hoa/thường, nguyên từ): `loading`, `empty`, `error`,
// `success`. `it.skip`/`it.todo` không được tính.
//
// Ngoại lệ: scripts/ui-states-allowlist.json — mảng `{ "file": "<đường dẫn từ gốc>", "reason": "<≥ 20 ký tự>" }`.
// Mục không lý do/lý do quá ngắn → thoát 2; mục trỏ file không còn là component dữ liệu → thoát 1 (không để danh sách mục).
//
// Thoát 0 = đạt; 1 = thiếu test/ca hoặc ngoại lệ mục; 2 = đầu vào/allowlist sai.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const COMPONENTS_DIR = "apps/storefront/src/components";
export const ALLOWLIST_FILE = "scripts/ui-states-allowlist.json";
export const MIN_REASON = 20;
export const STATES = ["loading", "empty", "error", "success"];

/** Bỏ chú thích dòng và chú thích khối (giữ nguyên chuỗi/ký tự khác; đủ cho việc dò lời gọi). */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let q = null;
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
    } else {
      if (c === '"' || c === "'" || c === "`") q = c;
      out += c;
      i++;
    }
  }
  return out;
}

export function isDataComponent(src) {
  const code = stripComments(src);
  const client = /^(["'])use client\1/.test(code.trimStart());
  return client && /(?<![\w.$])(fetch|fetchWithRetry)\s*\(/.test(code);
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** Các trạng thái có test trong một file test (theo tên it/test). */
export function statesIn(src) {
  const found = new Set();
  const re = /(?<![\w.$])(?:it|test)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of stripComments(src).matchAll(re)) {
    for (const s of STATES) {
      if (new RegExp(`(?<![\\p{L}\\d])${s}(?![\\p{L}\\d])`, "iu").test(m[2])) found.add(s);
    }
  }
  return found;
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
    const have = statesIn(readFileSync(join(root, cands[0]), "utf8"));
    const miss = STATES.filter((s) => !have.has(s));
    if (miss.length > 0) problems.push(`${f}: ${cands[0]} thiếu ca ${miss.join("/")}`);
  }
  const lines = [...problems, `${comps.length} component dữ liệu, ${problems.length} vấn đề`];
  return { code: problems.length > 0 ? 1 : 0, lines };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? join(here, "..");
  const r = check(root);
  for (const l of r.lines) (r.code === 0 ? console.log : console.error)(l);
  process.exit(r.code);
}
