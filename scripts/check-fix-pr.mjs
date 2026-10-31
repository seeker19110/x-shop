#!/usr/bin/env node
// Kiểm PR sửa lỗi (QA-STRAT-005, FE-TEST-006): PR có tiêu đề `fix:` phải đổi ít nhất một file test và ghi trong mô tả
// bằng chứng "đỏ trước / xanh sau". Ngoại lệ: nhãn `fix-no-test` kèm dòng `Ngoại lệ test: <lý do>` trong mô tả.
//
// CLI (chạy trong workflow pr-policy; dữ liệu PR đi qua biến môi trường, không nội suy vào shell):
//   PR_TITLE, PR_BODY, PR_LABELS (mảng JSON tên nhãn), FILES_PATH (file liệt kê file đổi, mỗi dòng một đường dẫn)
// Thoát 0 = đạt hoặc không phải PR `fix:`; 1 = vi phạm (in lý do); 2 = đầu vào không đọc được.
//
// Chế độ `--regression` (T-209, FE-TEST-006; job `regression` của pr-policy) CHẠY LẠI test mới/sửa của PR fix: trên HEAD
// phải xanh; trên commit base (mã nguồn base + file test của HEAD) phải ĐỎ — ít nhất một lệnh test fail.
//   node scripts/check-fix-pr.mjs --regression --base <sha> --head <sha> [--dry-run]
//   - PR fix = tiêu đề PR dạng `fix:`/`fix(...)` (D-152: squash-merge — subject commit trong PR không xét).
//   - File test = thêm/đổi/đổi tên trong `git diff base...head`; runner theo vị trí (xem `classifyTest`). Giữ thêm từ HEAD
//     các file hỗ trợ test trong thư mục `__tests__/` (fake, fixture) để test HEAD nạp được trên mã base.
//   - `--dry-run`: in kế hoạch (file → runner → lệnh), không đổi cây làm việc; có GITHUB_OUTPUT thì ghi `run=true|false`
//     (có lệnh test để chạy hay không — workflow chỉ cài phụ thuộc khi `true`).
//   - Chạy thật: cây làm việc phải sạch (file đã track); script checkout head → chạy; checkout base + file test của head →
//     chạy; cuối cùng trả lại ref ban đầu. Env: PR_TITLE, PR_BODY, PR_LABELS (không nội suy vào shell).
//   - Test tích hợp backend (Postgres/Redis thật + dựng app Medusa mỗi suite) và E2E Playwright KHÔNG chạy ở đây, chỉ cảnh
//     báo: job `gate` (ci.yml) đã chạy chúng trên HEAD; "đỏ trước" của chúng dựa vào dòng 'Đỏ trước:' (bước kiểm thân PR).
//   - Ngoại lệ — cùng quy ước bước kiểm thân PR: nhãn `fix-no-test` + 'Ngoại lệ test: <lý do ≥ 10 ký tự>' → "không có test"
//     hoặc "test không đỏ trên base" hạ thành cảnh báo; test đỏ trên HEAD vẫn đỏ.
//   Thoát 0 = đạt/bỏ qua; 1 = vi phạm; 2 = đầu vào/git lỗi (không kết luận được).
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXEMPT_LABEL = "fix-no-test";

const FIX_TITLE_RE = /^fix(\([^)\s]*\))?!?:\s*\S/;
const TEST_FILE_RES = [
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)(tests?|integration-tests|e2e)\//,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.(py|go)$/,
];

export function isFixTitle(title) {
  return FIX_TITLE_RE.test((title ?? "").trim());
}

export function isTestFile(path) {
  const p = (path ?? "").trim().replaceAll("\\", "/");
  return p !== "" && TEST_FILE_RES.some((re) => re.test(p));
}

/** Giá trị (không rỗng, sau khi bỏ chú thích HTML) của dòng `<nhãn>: <giá trị>` trong mô tả; không có → null. */
export function fieldOf(body, label) {
  const clean = (body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:[ \\t]*(\\S[^\\n]*)$`, "imu");
  const m = re.exec(clean);
  return m ? m[1].trim() : null;
}

/** Lý do ngoại lệ hợp lệ (nhãn `fix-no-test` + 'Ngoại lệ test: <≥ 10 ký tự>'); thiếu một trong hai → null. */
export function exemptionReason({ body, labels = [] }) {
  if (!labels.includes(EXEMPT_LABEL)) return null;
  const reason = fieldOf(body, "Ngoại lệ test");
  return reason !== null && reason.length >= 10 ? reason : null;
}

/**
 * @param {{title?: string, body?: string, labels?: string[], files?: string[]}} pr
 * @returns {{ok: boolean, skipped?: boolean, errors: string[]}}
 */
export function checkFixPr({ title, body, labels = [], files = [] }) {
  if (!isFixTitle(title)) return { ok: true, skipped: true, errors: [] };
  const exempt = labels.includes(EXEMPT_LABEL);
  if (exempt) {
    if (exemptionReason({ body, labels }) === null) {
      return {
        ok: false,
        errors: [`nhãn \`${EXEMPT_LABEL}\` cần dòng 'Ngoại lệ test: <lý do ≥ 10 ký tự>' trong mô tả PR`],
      };
    }
    return { ok: true, errors: [] };
  }
  const errors = [];
  if (!files.some(isTestFile)) {
    errors.push(
      `PR \`fix:\` phải thêm/sửa ít nhất một file test tái hiện lỗi (hoặc nhãn \`${EXEMPT_LABEL}\` + 'Ngoại lệ test: <lý do>')`,
    );
  }
  if (!fieldOf(body, "Đỏ trước"))
    errors.push("mô tả PR thiếu dòng 'Đỏ trước: <tên test + cách chạy, kết quả đỏ>'");
  if (!fieldOf(body, "Xanh sau")) errors.push("mô tả PR thiếu dòng 'Xanh sau: <cùng test, kết quả xanh>'");
  return { ok: errors.length === 0, errors };
}

// ───────────────────────────── Chế độ --regression (T-209): phần thuần ─────────────────────────────

/**
 * PR fix CHỈ theo tiêu đề PR `fix:`/`fix(...)` (D-152): repo squash-merge, tiêu đề PR thành commit trên master. Subject
 * commit trong PR không xét — PR `feat:` có commit `fix:` dọc đường không phải PR fix.
 */
export function isFixPr(title) {
  return isFixTitle(title);
}

/**
 * Runner của job regression: thư mục chạy (tương đối gốc repo), argv cố định (đường dẫn file test — tương đối `cwd` —
 * nối sau), env thêm. Không qua shell. Thứ tự khoá = thứ tự chạy.
 * - storefront: `scripts/test.mjs` của gói (vitest run + TZ/locale cố định, FE-TEST-003); tham số là bộ lọc đường dẫn.
 * - backend: đúng env của script `test` (TEST_TYPE=unit), `--runTestsByPath` = chỉ đúng các file; KHÔNG `--passWithNoTests`
 *   (file không khớp testMatch phải đỏ, không lặng lẽ xanh).
 */
export const RUNNERS = Object.freeze({
  "vitest-domain": {
    label: "vitest (packages/domain)",
    cwd: "packages/domain",
    argv: ["pnpm", "exec", "vitest", "run"],
    env: {},
  },
  "vitest-storefront": {
    label: "vitest (apps/storefront)",
    cwd: "apps/storefront",
    argv: ["node", "scripts/test.mjs"],
    env: {},
  },
  "jest-backend-unit": {
    label: "jest unit (apps/backend)",
    cwd: "apps/backend",
    argv: ["pnpm", "exec", "jest", "--runInBand", "--forceExit", "--runTestsByPath"],
    env: { TEST_TYPE: "unit", NODE_OPTIONS: "--experimental-vm-modules" },
  },
  "node-test": { label: "node --test", cwd: ".", argv: ["node", "--test"], env: {} },
});

export const SKIP_INTEGRATION =
  "test tích hợp backend (Postgres/Redis thật + dựng app Medusa) — job regression không chạy; job `gate` chạy trên HEAD";
export const SKIP_E2E =
  "E2E Playwright (cần stack chạy thật) — job regression không chạy; job `e2e` chạy trên HEAD";
export const SKIP_UNKNOWN = "file test không khớp runner nào của job regression";

const TEST_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const UNIT_SPEC_RE = /\.unit\.spec\.[jt]s$/;
const MODULE_TESTS_RE = /^src\/modules\/[^/]+\/__tests__\//;

const norm = (path) => (path ?? "").trim().replaceAll("\\", "/");

/**
 * Phân loại một file đổi của PR: `{runner, rel}` (chạy được; `rel` tương đối `RUNNERS[runner].cwd`), `{skip}` (là file
 * test nhưng job không chạy — kèm lý do), hoặc null (không phải file test). Khớp testMatch/include thật của từng gói:
 * domain `src/**\/*.test.ts`; storefront `src/**\/*.test.{ts,tsx}`; backend unit `src/**\/__tests__/**\/*.unit.spec.[jt]s`,
 * `src/admin/**\/__tests__/**\/*.unit.spec.tsx`, `integration-tests/__tests__/*.unit.spec.[jt]s`; script `*.test.mjs`
 * dưới `scripts/` hoặc `e2e/` (node --test). So khớp bằng tiền tố/hậu tố chuỗi, regex không có nhóm lặp.
 */
export function classifyTest(path) {
  const p = norm(path);
  if (!TEST_SUFFIX_RE.test(p)) return null;
  if (p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..")) return { skip: SKIP_UNKNOWN };
  if (p.startsWith("packages/domain/src/") && p.endsWith(".test.ts")) {
    return { runner: "vitest-domain", rel: p.slice("packages/domain/".length) };
  }
  if (p.startsWith("apps/storefront/src/") && (p.endsWith(".test.ts") || p.endsWith(".test.tsx"))) {
    return { runner: "vitest-storefront", rel: p.slice("apps/storefront/".length) };
  }
  if (p.startsWith("apps/backend/")) {
    const rel = p.slice("apps/backend/".length);
    const inSrcTests = rel.startsWith("src/") && rel.includes("/__tests__/");
    const adminTsx = rel.startsWith("src/admin/") && rel.endsWith(".unit.spec.tsx");
    if (inSrcTests && (UNIT_SPEC_RE.test(rel) || adminTsx)) return { runner: "jest-backend-unit", rel };
    const infra = "integration-tests/__tests__/";
    if (rel.startsWith(infra) && !rel.slice(infra.length).includes("/") && UNIT_SPEC_RE.test(rel)) {
      return { runner: "jest-backend-unit", rel };
    }
    if (rel.startsWith("integration-tests/http/") || MODULE_TESTS_RE.test(rel))
      return { skip: SKIP_INTEGRATION };
    return { skip: SKIP_UNKNOWN };
  }
  if (p.startsWith("e2e/") && p.endsWith(".spec.ts")) return { skip: SKIP_E2E };
  if ((p.startsWith("scripts/") || p.startsWith("e2e/")) && p.endsWith(".test.mjs"))
    return { runner: "node-test", rel: p };
  return { skip: SKIP_UNKNOWN };
}

/**
 * Kế hoạch chạy từ danh sách file đổi (A/C/M/R) của PR.
 * @returns {{groups: {runner: string, cwd: string, argv: string[], env: Record<string,string>, files: string[]}[],
 *   skipped: {file: string, reason: string}[], support: string[]}}
 *   `support` = file không phải test trong thư mục `__tests__/` (fake, fixture) — lấy bản HEAD khi chạy trên base.
 */
export function planRegression(files = []) {
  const byRunner = new Map();
  const skipped = [];
  const support = [];
  const seen = new Set();
  for (const raw of files) {
    const p = norm(raw);
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    const c = classifyTest(p);
    if (c === null) {
      if (p.includes("/__tests__/") && !p.split("/").includes("..")) support.push(p);
    } else if ("skip" in c) {
      skipped.push({ file: p, reason: c.skip });
    } else {
      if (!byRunner.has(c.runner)) byRunner.set(c.runner, []);
      byRunner.get(c.runner).push(c.rel);
    }
  }
  const groups = Object.keys(RUNNERS)
    .filter((k) => byRunner.has(k))
    .map((k) => {
      const r = RUNNERS[k];
      const rels = byRunner.get(k).sort();
      const files = rels.map((rel) => (r.cwd === "." ? rel : `${r.cwd}/${rel}`));
      return { runner: k, cwd: r.cwd, argv: [...r.argv, ...rels], env: { ...r.env }, files };
    });
  return { groups, skipped, support: support.sort() };
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** Lệnh tương đương để người đọc chạy lại tay (chỉ để in; script chạy argv, không qua shell). */
export function formatCommand(group) {
  const env = Object.entries(group.env).map(([k, v]) => `${k}=${shq(v)}`);
  const cmd = [...env, ...group.argv.map(shq)].join(" ");
  return group.cwd === "." ? cmd : `(cd ${shq(group.cwd)} && ${cmd})`;
}

/**
 * Quy tắc kết luận. `head`/`base`: mảng `{runner, ok}` cùng thứ tự `plan.groups` (null = chưa chạy).
 * 1. Không có lệnh nào: có test bị bỏ qua (tích hợp/E2E) → đạt + cảnh báo; ngoại lệ hợp lệ → đạt + cảnh báo; còn lại đỏ.
 * 2. Một lệnh đỏ trên HEAD → đỏ (không xét base).
 * 3. Mọi lệnh xanh trên base → "test không tái hiện lỗi": đỏ (ngoại lệ hợp lệ → cảnh báo). Ít nhất một lệnh đỏ → đạt.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function regressionVerdict({ plan, exempt = false, head = null, base = null }) {
  const errors = [];
  const warnings = plan.skipped.map((s) => `không chạy ${s.file}: ${s.reason}`);
  const done = () => ({ ok: errors.length === 0, errors, warnings });
  if (plan.groups.length === 0) {
    if (plan.skipped.length > 0) {
      warnings.push(
        "PR fix chỉ có test mà job regression không chạy — 'đỏ trước' dựa vào dòng 'Đỏ trước:' của mô tả",
      );
    } else if (exempt) {
      warnings.push(
        `PR fix không có test mới/sửa — chấp nhận theo ngoại lệ \`${EXEMPT_LABEL}\` + 'Ngoại lệ test:'`,
      );
    } else {
      errors.push(
        `PR fix không thêm/sửa file test nào (mẫu: *.test.ts(x), *.unit.spec.ts, *.spec.ts, scripts/*.test.mjs). Thêm test ` +
          `tái hiện lỗi, hoặc nhãn \`${EXEMPT_LABEL}\` + dòng 'Ngoại lệ test: <lý do>' trong mô tả`,
      );
    }
    return done();
  }
  const n = plan.groups.length;
  if (!Array.isArray(head) || head.length !== n) {
    errors.push("thiếu kết quả chạy trên HEAD — không kết luận được");
    return done();
  }
  const headRed = head.filter((r) => !r.ok).map((r) => r.runner);
  if (headRed.length > 0) {
    errors.push(`test của PR ĐỎ trên HEAD (${headRed.join(", ")}) — test phải xanh sau khi sửa`);
    return done();
  }
  if (!Array.isArray(base) || base.length !== n) {
    errors.push("thiếu kết quả chạy trên base — không kết luận được");
    return done();
  }
  if (base.every((r) => r.ok)) {
    const msg =
      "test không tái hiện lỗi: mọi test mới/sửa của PR đều XANH trên commit base (mã chưa sửa) — test hồi quy phải đỏ trước khi sửa";
    if (exempt) warnings.push(`${msg} (chấp nhận theo ngoại lệ \`${EXEMPT_LABEL}\`)`);
    else errors.push(msg);
  }
  return done();
}

/** Tham số CLI của chế độ --regression; sai → ném lỗi. */
export function parseRegressionArgs(argv) {
  const out = { base: null, head: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--regression") continue;
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--base" || a === "--head") {
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`${a} cần một commit (sha/ref)`);
      out[a.slice(2)] = v;
    } else throw new Error(`tham số không biết: ${a}`);
  }
  if (out.base === null || out.head === null) throw new Error("cần --base <sha> và --head <sha>");
  return out;
}

// ───────────────────────────── Chế độ --regression: phần I/O (git, chạy lệnh) ─────────────────────────────

const GROUP_TIMEOUT_MS = 10 * 60 * 1000;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} — ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

function runGroups(groups, top, phase) {
  return groups.map((g) => {
    console.log(`::group::[${phase}] ${RUNNERS[g.runner].label}: ${formatCommand(g)}`);
    const r = spawnSync(g.argv[0], g.argv.slice(1), {
      cwd: g.cwd === "." ? top : `${top}/${g.cwd}`,
      env: { ...process.env, ...g.env },
      stdio: "inherit",
      timeout: GROUP_TIMEOUT_MS,
    });
    console.log("::endgroup::");
    if (r.error && r.error.code !== "ETIMEDOUT") {
      // Không chạy được lệnh (vd thiếu pnpm) ≠ test đỏ: trên base nó sẽ bị tính nhầm là "tái hiện được".
      throw new Error(`không chạy được ${g.argv[0]}: ${r.error.message}`);
    }
    const ok = r.status === 0;
    const note = r.error ? `quá hạn ${GROUP_TIMEOUT_MS / 60000} phút` : `exit ${r.status ?? r.signal}`;
    console.log(`[${phase}] ${RUNNERS[g.runner].label}: ${ok ? "XANH" : "ĐỎ"} (${note})`);
    return { runner: g.runner, ok, note };
  });
}

function summary(plan, head, base, verdict) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const cell = (rs, i) => (rs?.[i] ? `${rs[i].ok ? "xanh" : "đỏ"} (${rs[i].note})` : "—");
  const lines = ["### regression (FE-TEST-006)", "", "| Runner | File | HEAD | base |", "|---|---|---|---|"];
  plan.groups.forEach((g, i) =>
    lines.push(
      `| ${RUNNERS[g.runner].label} | ${g.files.map((f) => `\`${f}\``).join("<br>")} | ${cell(head, i)} | ${cell(base, i)} |`,
    ),
  );
  lines.push("", `Kết luận: **${verdict.ok ? "ĐẠT" : "ĐỎ"}**`, ...verdict.errors.map((e) => `- lỗi: ${e}`));
  lines.push(...verdict.warnings.map((w) => `- cảnh báo: ${w}`), "");
  appendFileSync(path, lines.join("\n"));
}

function report(verdict) {
  for (const w of verdict.warnings) console.log(`::warning::regression: ${w}`);
  for (const e of verdict.errors) console.error(`::error::regression: ${e}`);
  if (verdict.ok) console.log("OK — regression đạt.");
  return verdict.ok ? 0 : 1;
}

function setOutput(run) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

function mainRegression(argv) {
  let args;
  let labels;
  let top;
  let base;
  let head;
  let files;
  try {
    args = parseRegressionArgs(argv);
    labels = JSON.parse(process.env.PR_LABELS || "[]");
    if (!Array.isArray(labels)) throw new Error("PR_LABELS phải là mảng JSON");
    top = git(["rev-parse", "--show-toplevel"]).trim();
    base = git(["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`], top).trim();
    head = git(["rev-parse", "--verify", "--end-of-options", `${args.head}^{commit}`], top).trim();
    files = git(["diff", "--name-only", "-z", "--diff-filter=ACMR", `${base}...${head}`], top).split("\0");
  } catch (e) {
    console.error(`::error::regression: không đọc được đầu vào — ${e.message}`);
    setOutput(false);
    return 2;
  }
  if (!isFixPr(process.env.PR_TITLE)) {
    console.log("Tiêu đề PR không phải `fix:` — bỏ qua (subject commit không xét, D-152).");
    setOutput(false);
    return 0;
  }
  const plan = planRegression(files);
  const exempt = exemptionReason({ body: process.env.PR_BODY, labels }) !== null;
  console.log(
    `PR fix — base ${base.slice(0, 12)}, head ${head.slice(0, 12)}${exempt ? ", có ngoại lệ hợp lệ" : ""}.`,
  );
  for (const g of plan.groups) console.log(`  ${RUNNERS[g.runner].label}: ${formatCommand(g)}`);
  for (const s of plan.skipped) console.log(`  bỏ qua ${s.file} — ${s.reason}`);
  if (plan.support.length > 0)
    console.log(`  file hỗ trợ test lấy bản HEAD khi chạy trên base: ${plan.support.join(", ")}`);
  setOutput(plan.groups.length > 0);
  if (plan.groups.length === 0) return report(regressionVerdict({ plan, exempt }));
  if (args.dryRun) {
    console.log("--dry-run: không chạy test.");
    return 0;
  }

  let original;
  try {
    if (git(["status", "--porcelain", "--untracked-files=no"], top).trim() !== "") {
      throw new Error(
        "cây làm việc có thay đổi chưa commit — commit/stash trước (script sẽ checkout head và base)",
      );
    }
    const branch = spawnSync("git", ["symbolic-ref", "-q", "--short", "HEAD"], {
      cwd: top,
      encoding: "utf8",
    });
    original = branch.status === 0 ? branch.stdout.trim() : git(["rev-parse", "HEAD"], top).trim();
  } catch (e) {
    console.error(`::error::regression: ${e.message}`);
    return 2;
  }
  let headResults = null;
  let baseResults = null;
  let restored = false;
  try {
    git(["checkout", "--quiet", "--detach", head], top);
    headResults = runGroups(plan.groups, top, "HEAD");
    if (headResults.every((r) => r.ok)) {
      const keep = [...plan.groups.flatMap((g) => g.files), ...plan.support];
      git(["checkout", "--quiet", "--detach", base], top);
      git(["checkout", "--quiet", head, "--", ...keep], top);
      baseResults = runGroups(plan.groups, top, "base");
    }
  } catch (e) {
    console.error(`::error::regression: không kết luận được — ${e.message}`);
    return 2;
  } finally {
    const back = spawnSync("git", ["checkout", "--quiet", "--force", original], {
      cwd: top,
      encoding: "utf8",
    });
    restored = back.status === 0;
    if (!restored)
      console.error(`::error::regression: không trả lại được ${original}: ${back.stderr.trim()}`);
  }
  if (!restored) return 2;
  const verdict = regressionVerdict({ plan, exempt, head: headResults, base: baseResults });
  summary(plan, headResults, baseResults, verdict);
  return report(verdict);
}

function main() {
  if (process.argv.includes("--regression")) return mainRegression(process.argv.slice(2));
  let labels;
  let files;
  try {
    labels = JSON.parse(process.env.PR_LABELS || "[]");
    if (!Array.isArray(labels)) throw new Error("PR_LABELS phải là mảng JSON");
    files = readFileSync(process.env.FILES_PATH ?? "", "utf8").split("\n");
  } catch (e) {
    console.error(`check-fix-pr: không đọc được đầu vào — ${e.message}`);
    return 2;
  }
  const r = checkFixPr({
    title: process.env.PR_TITLE,
    body: process.env.PR_BODY,
    labels,
    files: files.filter((f) => f.trim() !== ""),
  });
  if (r.skipped) console.log("Không phải PR `fix:` — bỏ qua.");
  else if (r.ok)
    console.log("OK — PR `fix:` có test và bằng chứng đỏ trước/xanh sau (hoặc ngoại lệ có lý do).");
  for (const e of r.errors) console.error(`::error::check-fix-pr: ${e}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
