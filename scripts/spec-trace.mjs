#!/usr/bin/env node
// Đối chiếu ID tiêu chí của docs/specs/SPEC-*.md với test (`node scripts/spec-trace.mjs`) — T-212, WF-SDD-003,
// PM-SPEC-004, Q-14 (giữ ID S-NNN + bí danh AT-NN, đối chiếu theo tên thay vì đổi nhãn).
//
// - ID tiêu chí = `### S-NNN` trong mục "Tiêu chí chấp nhận"; bí danh = `AT-NN`/`ATNN` ghi trong ngoặc ở tiêu đề.
// - Một ID "có test" khi MỘT file test nhắc `S-NNN` hoặc một bí danh `ATNN` của nó (từ khoá nguyên từ). File test: `*.test.*`,
//   `*.spec.*`, hoặc nằm dưới thư mục `__tests__`/`integration-tests`/`e2e`, trong apps/, packages/, e2e/, scripts/.
// - ID không test nào nhắc phải nằm trong scripts/spec-trace-allowlist.json kèm lý do ("chưa có test tự động — kiểm
//   tay/T-NNN"); không gắn nhãn bừa vào test không kiểm tiêu chí đó.
// - Mục allowlist sai là lỗi: ID không còn trong spec, ID đã có test (phải xoá khỏi allowlist), thiếu lý do.
//
// Thoát 0 = đạt; 1 = có ID thiếu test ngoài allowlist / allowlist sai; 2 = không đọc được đầu vào.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { criteriaSection, listSpecs, parseCriteria, SPECS_DIR } from "./check-specs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const ALLOWLIST_FILE = "scripts/spec-trace-allowlist.json";
const TEST_ROOTS = ["apps", "packages", "e2e", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".medusa", ".turbo"]);
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
// Fixture của chính bộ kiểm không được tính là phủ (chúng chứa ID giả lập).
const SELF_TESTS = new Set(["scripts/spec-trace.test.mjs", "scripts/check-specs.test.mjs"]);

/** Chỉ file `*.test.*`/`*.spec.*` tính là test; script diễn tập (vd integration-tests/ops/*.ts) không chạy trong CI nên không tính. */
export function isTestFile(relPath) {
  const p = relPath.split(sep).join("/");
  return TEST_NAME.test(p) && !SELF_TESTS.has(p);
}

export function listTestFiles(base = root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (isTestFile(relative(base, join(dir, e.name)))) out.push(join(dir, e.name));
    }
  };
  for (const r of TEST_ROOTS) if (existsSync(join(base, r))) walk(join(base, r));
  return out.sort();
}

/** Mọi token `S-NNN` / `ATNN` (nhận cả `AT-NN`, chuẩn hoá về `ATNN`) trong một đoạn văn bản. */
export function extractRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])S-(\d{3})(?![A-Za-z0-9_])/g)) refs.add(`S-${m[1]}`);
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])AT-?(\d{1,2})(?![A-Za-z0-9_])/g))
    refs.add(`AT${m[1].padStart(2, "0")}`);
  return refs;
}

/** criteria: [{id, aliases, spec}]; testRefs: Map<file, Set<ref>>; allowlist: [{id, reason}]. */
export function trace(criteria, testRefs, allowlist = []) {
  const errors = [];
  const covered = [];
  const allowed = [];
  const missing = [];
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const allow = new Map();
  for (const a of allowlist) {
    if (!a || typeof a.id !== "string") errors.push(`allowlist: mục thiếu "id": ${JSON.stringify(a)}`);
    else if (!a.reason || String(a.reason).trim().length < 10)
      errors.push(`allowlist: ${a.id} thiếu lý do (≥ 10 ký tự)`);
    else if (allow.has(a.id)) errors.push(`allowlist: trùng ${a.id}`);
    else allow.set(a.id, a);
  }
  for (const c of criteria) {
    const names = [c.id, ...c.aliases];
    const files = [...testRefs].filter(([, refs]) => names.some((n) => refs.has(n))).map(([f]) => f);
    if (files.length > 0) {
      covered.push({ ...c, files });
      if (allow.has(c.id)) errors.push(`allowlist: ${c.id} đã có test (${files[0]}) — xoá khỏi allowlist`);
    } else if (allow.has(c.id)) allowed.push(c);
    else missing.push(c);
  }
  for (const id of allow.keys())
    if (!byId.has(id)) errors.push(`allowlist: ${id} không còn trong spec — xoá khỏi allowlist`);
  const seen = new Set();
  for (const c of criteria) {
    if (seen.has(c.id)) errors.push(`ID tiêu chí trùng giữa các spec: ${c.id} (${c.spec})`);
    seen.add(c.id);
  }
  for (const c of missing)
    errors.push(
      `${c.spec} ${c.id}: không test nào nhắc (${[c.id, ...c.aliases].join("/")}) và không có trong allowlist`,
    );
  // Bí danh AT dùng chung giữa nhiều tiêu chí: một test nhắc AT đó phủ tất cả → chỉ cảnh báo (dữ liệu spec), không lỗi.
  const warnings = [];
  const owners = new Map();
  for (const c of criteria) for (const a of c.aliases) owners.set(a, [...(owners.get(a) ?? []), c.id]);
  for (const [a, ids] of owners)
    if (new Set(ids).size > 1)
      warnings.push(
        `bí danh ${a} dùng chung ${[...new Set(ids)].join(", ")} — nên gắn ID S-NNN riêng vào test để không phủ chéo`,
      );
  return { covered, allowed, missing, errors, warnings };
}

export function loadCriteria(dir = join(root, SPECS_DIR)) {
  const out = [];
  for (const f of listSpecs(dir)) {
    const section = criteriaSection(readFileSync(join(dir, f), "utf8"));
    if (section) for (const c of parseCriteria(section)) out.push({ ...c, spec: f });
  }
  return out;
}

export function run(base = root) {
  const specsDir = join(base, SPECS_DIR);
  if (!existsSync(specsDir)) return { code: 2, errors: [`không thấy ${specsDir}`] };
  const criteria = loadCriteria(specsDir);
  if (criteria.length === 0) return { code: 1, errors: ["không trích được ID tiêu chí nào từ docs/specs"] };
  const testRefs = new Map();
  for (const f of listTestFiles(base)) testRefs.set(relative(base, f), extractRefs(readFileSync(f, "utf8")));
  let allowlist = [];
  const af = join(base, ALLOWLIST_FILE);
  if (existsSync(af)) {
    try {
      allowlist = JSON.parse(readFileSync(af, "utf8"));
    } catch (e) {
      return { code: 2, errors: [`${ALLOWLIST_FILE} không phải JSON hợp lệ: ${e.message}`] };
    }
    if (!Array.isArray(allowlist))
      return { code: 2, errors: [`${ALLOWLIST_FILE} phải là mảng [{id, reason}]`] };
  }
  const res = trace(criteria, testRefs, allowlist);
  return { code: res.errors.length ? 1 : 0, total: criteria.length, ...res };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = run();
  for (const w of r.warnings ?? []) console.warn(`spec-trace: cảnh báo: ${w}`);
  for (const e of r.errors) console.error(`spec-trace: ${e}`);
  if (r.code === 0) {
    console.log(
      `spec-trace: OK — ${r.total} tiêu chí: ${r.covered.length} có test, ${r.allowed.length} trong allowlist (chưa có test tự động).`,
    );
  }
  process.exit(r.code);
}
