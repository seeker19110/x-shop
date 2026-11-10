#!/usr/bin/env node
// Khớp `.github/dependabot.yml` với manifest thật (`node scripts/check-dependabot.mjs [--root <dir>]`) — T-202,
// OPS-MAINT-001, BASE-DEP-006, BASE-DEP-007.
//
// Tập mong đợi (ecosystem, directory) suy từ repo:
//   npm             — pnpm workspace có MỘT lockfile ở gốc (`pnpm-workspace.yaml` + `pnpm-lock.yaml`): CHỈ `/` — khối gốc
//                     đã phủ package.json của mọi thư mục workspace và cập nhật lockfile; khối con (`/apps/x`) sinh PR chỉ sửa
//                     package.json, thiếu lockfile → `--frozen-lockfile` hỏng (T-242, D-168: #22/#23/#25). Khai khối con → lỗi.
//                     Ngoài ra (npm/yarn workspaces, không lockfile pnpm gốc): mỗi thư mục có package.json một khối.
//                     Mẫu workspace vẫn được kiểm (chỉ `dir/*` hoặc đường dẫn cụ thể) ở cả hai trường hợp.
//   github-actions  — `/` nếu `.github/workflows/` có file .yml/.yaml.
//   docker          — thư mục chứa `Dockerfile` hoặc `Dockerfile.*` (bỏ node_modules, thư mục ẩn như .git/.claude, build output).
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

export class UnsupportedPatternError extends Error {}

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
    const unsupported = p.startsWith("!") || p.includes("**") || (p.includes("*") && !/^[^*]+\/\*$/.test(p));
    if (unsupported)
      throw new UnsupportedPatternError(
        `mẫu workspace chưa hỗ trợ: '${raw}' (chỉ 'dir/*' hoặc đường dẫn cụ thể)`,
      );
    if (p.endsWith("/*")) {
      const base = join(root, p.slice(0, -2));
      for (const e of subdirs(base)) dirs.add(join(base, e.name));
    } else dirs.add(join(root, p));
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
        // Thư mục ẩn (.claude/worktrees, .git, .cache…) không phải manifest của repo.
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(abs, e.name));
      } else if (e.name === "Dockerfile" || e.name.startsWith("Dockerfile.")) out.add(abs);
    }
  };
  walk(root);
  return [...out];
}

/** pnpm workspace một lockfile ở gốc → Dependabot chỉ được khai khối npm `/` (T-242). */
export const pnpmRootLockfile = (root) =>
  existsSync(join(root, "pnpm-workspace.yaml")) && existsSync(join(root, "pnpm-lock.yaml"));

export function expectedManifests(root) {
  const set = new Set();
  if (existsSync(join(root, "package.json"))) {
    const dirs = workspaceDirs(root); // luôn chạy: mẫu workspace lạ vẫn ném UnsupportedPatternError
    if (pnpmRootLockfile(root)) set.add("npm /");
    else for (const d of dirs) if (existsSync(join(d, "package.json"))) set.add(`npm ${toDir(root, d)}`);
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
  // Thành viên workspace (có package.json) — chỉ những thư mục này mới "đã được khối `/` phủ".
  const members = pnpmRootLockfile(root)
    ? new Set(
        workspaceDirs(root)
          .filter((d) => existsSync(join(d, "package.json")))
          .map((d) => `npm ${toDir(root, d)}`),
      )
    : new Set();
  for (const e of [...declared].sort()) {
    if (expected.has(e)) continue;
    if (members.has(e))
      errors.push(
        `pnpm workspace một lockfile ở gốc: bỏ khối ${e} — khối npm \`/\` đã phủ thư mục này; khối con sinh PR thiếu pnpm-lock.yaml`,
      );
    else errors.push(`dependabot khai báo mà repo không có manifest tương ứng: ${e}`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i > 0 ? process.argv[i + 1] : ".");
  let errors;
  try {
    errors = check(root);
  } catch (e) {
    if (!(e instanceof UnsupportedPatternError)) throw e;
    console.error(`check-dependabot: ${e.message}`);
    process.exit(2);
  }
  if (errors.length) {
    for (const e of errors) console.error(`::error::check-dependabot: ${e}`);
    process.exit(1);
  }
  console.log(`OK — dependabot.yml khớp ${expectedManifests(root).size} manifest.`);
}
