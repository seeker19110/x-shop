#!/usr/bin/env node
// Gói phụ thuộc trực tiếp mới phải được giải trình trong thân PR (`node scripts/check-new-deps.mjs [--base <ref>] [--root <dir>]`)
// — T-202, OPS-MAINT-001, BASE-DEP-006.
//
// So `dependencies` + `devDependencies` của mọi package.json giữa base (merge-base của base và HEAD; base = --base, env
// BASE_SHA, mặc định `origin/master`; đọc bằng `git show`) và HEAD (working tree). Gói mới (khai báo `workspace:` bị bỏ qua) →
// thân PR (env PR_BODY, không nội suy shell) phải có mục `## Phụ thuộc mới` chứa tên từng gói mới.
// Thiếu → exit 1. Không có gói mới → exit 0 (kể cả không có PR_BODY). Lỗi git → exit 2.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Khoá override của pnpm: `foo`, `foo@<2`, `parent>foo`, `@scope/foo@1` -> tên gói đích.
const overrideName = (key) => {
  const last = String(key).split(">").pop();
  const at = last.indexOf("@", 1);
  return at > 0 ? last.slice(0, at) : last;
};

export const directDeps = (json, isRoot = false) => {
  const out = new Set();
  for (const f of FIELDS)
    for (const [name, ver] of Object.entries(json?.[f] ?? {}))
      if (!String(ver).startsWith("workspace:")) out.add(name);
  if (isRoot)
    for (const [key, ver] of Object.entries(json?.pnpm?.overrides ?? {}))
      if (!String(ver).startsWith("workspace:")) out.add(overrideName(key));
  return out;
};

export function newDirectDeps(root, base) {
  let ref = base;
  try {
    ref = git(root, ["merge-base", base, "HEAD"]).trim() || base;
  } catch {
    /* không có merge-base: so thẳng với base */
  }
  const files = git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "package.json",
    "**/package.json",
  ])
    .split("\n")
    .filter(Boolean);
  const result = [];
  for (const path of [...new Set(files)].sort()) {
    if (path.includes("node_modules/") || !existsSync(join(root, path))) continue;
    let before = new Set();
    try {
      before = directDeps(JSON.parse(git(root, ["show", `${ref}:${path}`])), path === "package.json");
    } catch {
      /* file mới ở HEAD: mọi gói đều mới */
    }
    const now = directDeps(JSON.parse(readFileSync(join(root, path), "utf8")), path === "package.json");
    for (const name of [...now].sort()) if (!before.has(name)) result.push({ path, name });
  }
  return result;
}

const isNameChar = (c) => c !== undefined && /[A-Za-z0-9._~-]/.test(c);
const TRAIL_PUNCT = new Set([".", ",", ";", ":"]);

export function sectionNewDeps(body) {
  const text = String(body ?? "")
    .normalize("NFC")
    .replace(/<!--[\s\S]*?-->/g, "");
  const lines = text.split(/\r?\n/);
  // Dòng `## ` trong code fence không phải tiêu đề mục.
  let fenced = false;
  const isHeading = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && /^##\s/.test(l);
  });
  const start = lines.findIndex((l, i) => isHeading[i] && /^##\s+Phụ thuộc mới\s*:?\s*$/u.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !isHeading[i]; i++) out.push(lines[i]);
  return out.join("\n");
}

// Tên gói đúng ranh giới: trước không phải ký tự tên, `/` hay `@` (tránh `b` khớp `@a/b`, `react` khớp `@types/react`);
// sau không phải ký tự tên, trừ dấu câu cuối (`.,;:`) đứng ngay trước khoảng trắng/hết chuỗi.
const mentions = (section, name) => {
  const target = name.normalize("NFC");
  let from = 0;
  for (;;) {
    const at = section.indexOf(target, from);
    if (at < 0) return false;
    const before = section[at - 1];
    const end = at + target.length;
    let after = section[end];
    if (TRAIL_PUNCT.has(after) && !isNameChar(section[end + 1])) after = undefined;
    if (!isNameChar(before) && before !== "/" && before !== "@" && !isNameChar(after)) return true;
    from = at + 1;
  }
};

export function check(added, body) {
  if (added.length === 0) return [];
  const section = sectionNewDeps(body);
  if (section === null)
    return [
      `PR thêm gói trực tiếp mới nhưng thiếu mục '## Phụ thuộc mới' (gói: ${added.map((a) => a.name).join(", ")})`,
    ];
  const errors = [];
  for (const { path, name } of added)
    if (!mentions(section, name))
      errors.push(
        `mục '## Phụ thuộc mới' chưa nêu gói '${name}' (thêm ở ${path}): ghi lý do chọn, giấy phép, bảo trì`,
      );
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const root = resolve(arg("--root") ?? ".");
  const base = arg("--base") ?? process.env.BASE_SHA ?? "origin/master";
  let added;
  try {
    added = newDirectDeps(root, base);
  } catch (e) {
    console.error(`check-new-deps: không đọc được git (${String(e.message).split("\n")[0]})`);
    process.exit(2);
  }
  for (const a of added) console.log(`gói mới: ${a.name} (${a.path})`);
  const errors = check(added, process.env.PR_BODY);
  if (errors.length) {
    for (const e of errors) console.error(`::error::check-new-deps: ${e}`);
    process.exit(1);
  }
  console.log(`OK — ${added.length} gói trực tiếp mới, đã giải trình.`);
}
