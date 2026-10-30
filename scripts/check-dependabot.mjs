#!/usr/bin/env node
// Khớp `.github/dependabot.yml` với manifest thật (`node scripts/check-dependabot.mjs [--root <dir>]`) — T-202,
// OPS-MAINT-001, BASE-DEP-006, BASE-DEP-007.
//
// Tập mong đợi (ecosystem, directory) suy từ repo:
//   npm             — mỗi thư mục có package.json: gốc + các thư mục của pnpm-workspace.yaml (mẫu `dir/*` hoặc đường dẫn cụ thể).
//   github-actions  — `/` nếu `.github/workflows/` có file .yml/.yaml.
//   docker          — thư mục chứa `Dockerfile` hoặc `Dockerfile.*` (bỏ node_modules, .git, build output).
// Thiếu khối khai báo cho manifest → exit 1; khai báo mà manifest không còn (Dependabot lỗi mỗi lượt) → exit 1.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SKIP = new Set(["node_modules", ".git", ".medusa", ".next", "dist", "build", "coverage"]);

const toDir = (root, abs) => {
  const rel = relative(root, abs).split(sep).join("/");
  return rel === "" ? "/" : `/${rel}`;
};
const normDir = (d) => {
  const s = String(d ?? "").replace(/\/+$/, "");
  return s === "" ? "/" : s.startsWith("/") ? s : `/${s}`;
};

function subdirs(abs) {
  try {
    return readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name));
  } catch {
    return [];
  }
}

function workspaceDirs(root) {
  const dirs = new Set([root]);
  const file = join(root, "pnpm-workspace.yaml");
  let patterns = [];
  if (existsSync(file)) patterns = parse(readFileSync(file, "utf8"))?.packages ?? [];
  else {
    const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces;
    patterns = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  }
  for (const raw of patterns) {
    const p = String(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    if (p.startsWith("!")) continue;
    if (p.endsWith("/*")) {
      const base = join(root, p.slice(0, -2));
      for (const e of subdirs(base)) dirs.add(join(base, e.name));
    } else if (!p.includes("*")) dirs.add(join(root, p));
  }
  return [...dirs];
}

function findDockerDirs(root) {
  const out = new Set();
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(abs, e.name));
      } else if (e.name === "Dockerfile" || e.name.startsWith("Dockerfile.")) out.add(abs);
    }
  };
  walk(root);
  return [...out];
}

export function expectedManifests(root) {
  const set = new Set();
  if (existsSync(join(root, "package.json"))) {
    for (const d of workspaceDirs(root))
      if (existsSync(join(d, "package.json"))) set.add(`npm ${toDir(root, d)}`);
  }
  const wf = join(root, ".github", "workflows");
  if (existsSync(wf) && readdirSync(wf).some((f) => /\.ya?ml$/.test(f))) set.add("github-actions /");
  for (const d of findDockerDirs(root)) set.add(`docker ${toDir(root, d)}`);
  return set;
}

export function declaredEntries(root) {
  const file = join(root, ".github", "dependabot.yml");
  if (!existsSync(file)) return null;
  const doc = parse(readFileSync(file, "utf8"));
  const set = new Set();
  for (const u of doc?.updates ?? []) {
    const dirs = u.directories ?? [u.directory];
    for (const d of dirs) set.add(`${u["package-ecosystem"]} ${normDir(d)}`);
  }
  return set;
}

export function check(root) {
  const declared = declaredEntries(root);
  const expected = expectedManifests(root);
  if (declared === null) return expected.size ? ["thiếu .github/dependabot.yml"] : [];
  const errors = [];
  for (const e of [...expected].sort())
    if (!declared.has(e)) errors.push(`thiếu khối dependabot cho manifest: ${e}`);
  for (const e of [...declared].sort())
    if (!expected.has(e)) errors.push(`dependabot khai báo mà repo không có manifest tương ứng: ${e}`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i > 0 ? process.argv[i + 1] : ".");
  const errors = check(root);
  if (errors.length) {
    for (const e of errors) console.error(`::error::check-dependabot: ${e}`);
    process.exit(1);
  }
  console.log(`OK — dependabot.yml khớp ${expectedManifests(root).size} manifest.`);
}
