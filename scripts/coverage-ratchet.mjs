#!/usr/bin/env node
// Ratchet coverage (QA-COV-002): so `coverage/coverage-summary.json` (reporter `json-summary`) của từng gói với
// coverage-baseline.json đã commit. Tỉ lệ `lines` hoặc `branches` của một gói thấp hơn baseline → exit 1. Thiếu file
// summary của một gói có trong baseline → exit 1 (không đo được ≠ đạt). Baseline chỉ tăng: `--update` ghi giá trị
// max(cũ, đo) — không bao giờ hạ; `--against <ref>` đỏ khi baseline trong cây làm việc thấp hơn bản ở `<ref>` (PR hạ
// baseline bằng tay). Chạy sau `pnpm -r --if-present test:coverage`.
// Nguồn integration (QA-COV-001, T-135): baseline có thể thêm khoá "integration": {packages: {...}} cùng dạng; `--suite
// integration` đọc `<gói>/coverage-integration/coverage-summary.json` (từ `test:integration:coverage`) và so/ghi CHỈ
// mục đó. Mặc định (không `--suite`) chỉ so mục `packages` (unit) nên không đòi chạy test tích hợp. `--against` luôn
// so cả hai mục (không được hạ hay xoá mục integration đã có ở ref).
// CLI: node scripts/coverage-ratchet.mjs [--suite unit|integration] [--update] [--against <git-ref>]
//      [--baseline <file>] [--root <dir>]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const METRICS = ["lines", "branches"];
export const BASELINE_FILE = "coverage-baseline.json";
export const SUMMARY_PATH = join("coverage", "coverage-summary.json");
/** Nguồn đo: `key` = khoá của mục trong baseline (null = `packages` ở gốc), `dir` = thư mục coverage của gói. */
export const SUITES = {
  unit: { key: null, dir: "coverage", script: "test:coverage" },
  integration: { key: "integration", dir: "coverage-integration", script: "test:integration:coverage" },
};
const summaryPath = (suite) => join(SUITES[suite].dir, "coverage-summary.json");
/** Mục `{packages}` của baseline theo nguồn; nguồn integration chưa có → null. */
export const section = (baseline, suite = "unit") =>
  SUITES[suite].key === null ? baseline : (baseline[SUITES[suite].key] ?? null);

const isPct = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/** Tỉ lệ tổng {lines, branches} từ nội dung coverage-summary.json; sai dạng → ném lỗi nêu chỗ sai. */
export function parseSummary(text, label = "summary") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: JSON không hợp lệ (${e.message})`);
  }
  const out = {};
  for (const m of METRICS) {
    const pct = data?.total?.[m]?.pct;
    if (!isPct(pct))
      throw new Error(`${label}: thiếu total.${m}.pct dạng số 0–100 (có: ${JSON.stringify(pct)})`);
    out[m] = pct;
  }
  return out;
}

/** Kiểm cấu trúc baseline: {packages: {<dir>: {lines, branches}}} với ít nhất một gói. Sai → ném lỗi. */
export function validateBaseline(baseline, label = BASELINE_FILE) {
  const check = (pkgs, where) => {
    if (!pkgs || typeof pkgs !== "object" || Array.isArray(pkgs) || Object.keys(pkgs).length === 0) {
      throw new Error(`${label}: cần "${where}" là object không rỗng`);
    }
    for (const [dir, v] of Object.entries(pkgs)) {
      for (const m of METRICS) {
        if (!isPct(v?.[m])) throw new Error(`${label}: ${where}["${dir}"].${m} phải là số 0–100`);
      }
    }
  };
  check(baseline?.packages, "packages");
  if (baseline.integration !== undefined) check(baseline.integration?.packages, "integration.packages");
  return baseline;
}

/**
 * So số đo với baseline. `actual`: {<dir>: {lines, branches} | null} (null = thiếu summary).
 * Trả {failures: [chuỗi], improved: [chuỗi]}; failures rỗng = đạt.
 */
export function compare(baseline, actual, suite = "unit") {
  const failures = [];
  const improved = [];
  for (const [dir, base] of Object.entries(baseline.packages)) {
    const got = actual[dir];
    if (!got) {
      failures.push(
        `${dir}: thiếu ${summaryPath(suite)} — chạy \`pnpm -r --if-present ${SUITES[suite].script}\` trước`,
      );
      continue;
    }
    for (const m of METRICS) {
      if (got[m] < base[m]) failures.push(`${dir}: ${m} ${got[m]} % < baseline ${base[m]} %`);
      else if (got[m] > base[m]) improved.push(`${dir}: ${m} ${base[m]} % → ${got[m]} %`);
    }
  }
  return { failures, improved };
}

/** Baseline mới = max(cũ, đo) từng chỉ số; gói đo được mà chưa có thì thêm. Không bao giờ hạ, không xoá gói. */
export function raise(baseline, actual) {
  const packages = {};
  const dirs = new Set([...Object.keys(baseline.packages), ...Object.keys(actual)]);
  for (const dir of [...dirs].sort()) {
    const base = baseline.packages[dir];
    const got = actual[dir];
    if (!got) {
      packages[dir] = { ...base };
      continue;
    }
    packages[dir] = Object.fromEntries(METRICS.map((m) => [m, base ? Math.max(base[m], got[m]) : got[m]]));
  }
  return { ...baseline, packages };
}

/** Baseline ở cây làm việc so với bản cũ (`--against`): chỉ số thấp hơn hoặc gói bị xoá → lỗi. */
export function compareBaselines(previous, current) {
  const failures = [];
  const pairs = [["", previous, current]];
  if (previous.integration) pairs.push(["integration ", previous.integration, current.integration ?? {}]);
  for (const [prefix, prev, cur] of pairs) {
    if (!cur.packages) {
      failures.push(`${prefix.trim()}: mục bị xoá khỏi baseline (bản cũ có)`);
      continue;
    }
    for (const [dir, old] of Object.entries(prev.packages)) {
      const now = cur.packages[dir];
      if (!now) {
        failures.push(`${prefix}${dir}: bị xoá khỏi baseline (bản cũ có)`);
        continue;
      }
      for (const m of METRICS) {
        if (now[m] < old[m]) failures.push(`${prefix}${dir}: baseline ${m} bị hạ ${old[m]} % → ${now[m]} %`);
      }
    }
  }
  return failures;
}

function readActual(root, dirs, suite = "unit") {
  const actual = {};
  for (const dir of dirs) {
    let text;
    try {
      text = readFileSync(join(root, dir, summaryPath(suite)), "utf8");
    } catch {
      actual[dir] = null;
      continue;
    }
    actual[dir] = parseSummary(text, join(dir, summaryPath(suite)));
  }
  return actual;
}

function parseArgs(argv) {
  const opts = { update: false, against: null, baseline: BASELINE_FILE, root: ".", suite: "unit" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") opts.update = true;
    else if (a === "--against" || a === "--baseline" || a === "--root" || a === "--suite") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} cần giá trị`);
      opts[a.slice(2)] = v;
    } else throw new Error(`tham số lạ: ${a}`);
  }
  return opts;
}

/** Bản baseline ở ref git; ref không có file → null. Lỗi git khác (ref sai) → ném lỗi. */
export function baselineAtRef(root, ref, file, run = execFileSync) {
  let text;
  try {
    text = run("git", ["show", `${ref}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const msg = String(e.stderr ?? e.message);
    if (/does not exist in|exists on disk, but not in/.test(msg)) return null;
    throw new Error(`git show ${ref}:${file} lỗi: ${msg.trim()}`);
  }
  return validateBaseline(JSON.parse(text), `${ref}:${file}`);
}

export function main(argv = process.argv.slice(2), log = console) {
  let opts;
  try {
    opts = parseArgs(argv);
    const root = resolve(opts.root);
    const file = join(root, opts.baseline);
    const baseline = validateBaseline(JSON.parse(readFileSync(file, "utf8")), opts.baseline);
    if (!Object.hasOwn(SUITES, opts.suite))
      throw new Error(`--suite phải là ${Object.keys(SUITES).join("|")} (có: ${opts.suite})`);
    const target = section(baseline, opts.suite);
    if (!target)
      throw new Error(`${opts.baseline}: chưa có mục "${SUITES[opts.suite].key}" cho --suite ${opts.suite}`);
    let rc = 0;

    if (opts.against) {
      const prev = baselineAtRef(root, opts.against, opts.baseline);
      if (prev === null)
        log.log(`coverage-ratchet: ${opts.against} chưa có ${opts.baseline} — bỏ qua so baseline`);
      else {
        const bad = compareBaselines(prev, baseline);
        for (const f of bad) log.error(`✗ ${f}`);
        if (bad.length) rc = 1;
        else log.log(`coverage-ratchet: baseline không hạ so với ${opts.against}`);
      }
    }

    const actual = readActual(root, Object.keys(target.packages), opts.suite);
    const { failures, improved } = compare(target, actual, opts.suite);
    for (const f of failures) log.error(`✗ ${f}`);
    for (const i of improved) log.log(`↑ ${i}`);

    if (opts.update) {
      if (failures.length) {
        log.error("coverage-ratchet: không cập nhật baseline khi còn chỉ số dưới baseline/thiếu summary");
        return 1;
      }
      const raised = raise(target, actual);
      const next =
        SUITES[opts.suite].key === null ? raised : { ...baseline, [SUITES[opts.suite].key]: raised };
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      log.log(`coverage-ratchet: đã ghi ${opts.baseline} (chỉ tăng)`);
      return rc;
    }
    if (failures.length) {
      log.error("coverage-ratchet: ĐỎ — thêm test cho nhánh/dòng thiếu; không hạ baseline");
      return 1;
    }
    if (improved.length)
      log.log("coverage-ratchet: tăng so với baseline — `--update` để nâng baseline (tuỳ chọn)");
    log.log(
      `coverage-ratchet: ${rc ? "ĐỎ" : "xanh"} (${opts.suite}: ${Object.keys(target.packages).length} gói, ${METRICS.join(", ")})`,
    );
    return rc;
  } catch (e) {
    log.error(`coverage-ratchet: ${e.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
