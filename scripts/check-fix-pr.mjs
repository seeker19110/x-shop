#!/usr/bin/env node
// Kiểm PR sửa lỗi (QA-STRAT-005, FE-TEST-006): PR có tiêu đề `fix:` phải đổi ít nhất một file test và ghi trong mô tả
// bằng chứng "đỏ trước / xanh sau". Ngoại lệ: nhãn `fix-no-test` kèm dòng `Ngoại lệ test: <lý do>` trong mô tả.
//
// CLI (chạy trong workflow pr-policy; dữ liệu PR đi qua biến môi trường, không nội suy vào shell):
//   PR_TITLE, PR_BODY, PR_LABELS (mảng JSON tên nhãn), FILES_PATH (file liệt kê file đổi, mỗi dòng một đường dẫn)
// Thoát 0 = đạt hoặc không phải PR `fix:`; 1 = vi phạm (in lý do); 2 = đầu vào không đọc được.
//
// Chế độ `--regression` (T-209, FE-TEST-006; job `regression` của pr-policy) CHẠY LẠI test mới/sửa của PR fix: trên HEAD
// phải xanh; trên commit base (mã nguồn base + file test của HEAD) phải ĐỎ Ở MỨC TEST CASE (D-153): ít nhất một test case
// (cùng file + tên đầy đủ) fail trên base và pass trên HEAD. Base đỏ không ở mức case (0 case chạy, "Test suite failed to
// run", case mang tên file, case gọi export/binding import/module chưa có trên base, hook lỗi — D-154: mọi hook, kể cả
// beforeEach/afterEach —, không đọc được report/quá hạn) không chứng minh tái hiện → đỏ.
//   node scripts/check-fix-pr.mjs --regression --base <sha> --head <sha> [--dry-run]
//   - PR fix = tiêu đề PR dạng `fix:`/`fix(...)` (D-152: squash-merge — subject commit trong PR không xét).
//   - File test = thêm/đổi/đổi tên trong `git diff base...head`; runner theo vị trí (xem `classifyTest`). Giữ thêm từ HEAD
//     các file hỗ trợ test trong thư mục `__tests__/` (fake, fixture) để test HEAD nạp được trên mã base.
//   - Kết quả từng runner đọc từ report máy đọc được ghi ra thư mục tạm NGOÀI repo (vitest json, jest --json, node junit —
//     node --test chạy từng file vì JUnit của node không ghi file nguồn); phân tích bằng hàm thuần `parseReport`.
//   - `--dry-run`: in kế hoạch (file → runner → lệnh), không đổi cây làm việc; có GITHUB_OUTPUT thì ghi `run=true|false`
//     (có lệnh test để chạy hay không — workflow chỉ cài phụ thuộc khi `true`).
//   - Chạy thật: cây làm việc phải sạch (file đã track); script in lệnh khôi phục, checkout head → chạy; checkout base +
//     file test của head → chạy; cuối cùng trả lại ref ban đầu (cả khi lỗi). Env: PR_TITLE, PR_BODY, PR_LABELS.
//   - Test tích hợp backend (Postgres/Redis thật + dựng app Medusa mỗi suite) và E2E Playwright KHÔNG chạy ở đây, chỉ cảnh
//     báo: job `gate` (ci.yml) đã chạy chúng trên HEAD; "đỏ trước" của chúng dựa vào dòng 'Đỏ trước:' (bước kiểm thân PR).
//     File test không khớp runner nào và không job CI nào chạy (vd `*.spec.ts` ngoài `__tests__`) → ĐỎ "không chạy ở đâu".
//   - Ngoại lệ — cùng quy ước bước kiểm thân PR: nhãn `fix-no-test` + 'Ngoại lệ test: <lý do ≥ 10 ký tự>' → "không có test",
//     "file test không chạy ở đâu", "base không tái hiện" hạ thành cảnh báo; test đỏ trên HEAD vẫn đỏ.
//   Thoát 0 = đạt/bỏ qua; 1 = vi phạm; 2 = đầu vào/git lỗi (không kết luận được).
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  // Bỏ chú thích HTML lặp tới khi ổn định: chú thích lồng/ghép (`<!<!---->--`) không còn sót `<!--` (CodeQL
  // js/incomplete-multi-character-sanitization); `<!--` không đóng thì bỏ tới hết thân.
  let clean = String(body ?? "");
  for (let prev = ""; prev !== clean;) {
    prev = clean;
    clean = clean.replace(/<!--[\s\S]*?-->/g, "");
  }
  clean = clean.replace(/<!--[\s\S]*$/, "");
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
 * nối sau), env thêm, loại report máy đọc được (`report`; cờ ghi report chèn lúc chạy, xem `runArgv`). Không qua shell.
 * Thứ tự khoá = thứ tự chạy.
 * - storefront: `scripts/test.mjs` của gói (vitest run + TZ/locale cố định, FE-TEST-003); tham số chuyển nguyên cho vitest.
 * - backend: đúng env của script `test` (TEST_TYPE=unit), `--runTestsByPath` = chỉ đúng các file; KHÔNG `--passWithNoTests`
 *   (file không khớp testMatch phải đỏ, không lặng lẽ xanh).
 * - node --test: `perFile` — mỗi file một lần chạy, vì report JUnit của node không ghi file nguồn của test case.
 */
export const RUNNERS = Object.freeze({
  "vitest-domain": {
    label: "vitest (packages/domain)",
    cwd: "packages/domain",
    argv: ["pnpm", "exec", "vitest", "run"],
    env: {},
    report: "vitest-json",
  },
  "vitest-storefront": {
    label: "vitest (apps/storefront)",
    cwd: "apps/storefront",
    argv: ["node", "scripts/test.mjs"],
    env: {},
    report: "vitest-json",
  },
  "jest-backend-unit": {
    label: "jest unit (apps/backend)",
    cwd: "apps/backend",
    argv: ["pnpm", "exec", "jest", "--runInBand", "--forceExit", "--runTestsByPath"],
    env: { TEST_TYPE: "unit", NODE_OPTIONS: "--experimental-vm-modules" },
    report: "jest-json",
  },
  "node-test": {
    label: "node --test",
    cwd: ".",
    argv: ["node", "--test"],
    env: {},
    report: "junit",
    perFile: true,
  },
});

/**
 * Cờ ghi report máy đọc được vào `out` (file tạm ngoài repo), đã kiểm trên vitest 5.0.5, jest 29.7.0, node 22.22.0.
 * Reporter mặc định giữ nguyên để log CI vẫn đọc được bằng mắt.
 */
export function reportArgs(kind, out) {
  if (kind === "vitest-json") return ["--reporter=default", "--reporter=json", `--outputFile.json=${out}`];
  if (kind === "jest-json") return ["--json", `--outputFile=${out}`];
  if (kind === "junit") {
    return [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${out}`,
    ];
  }
  throw new Error(`loại report không biết: ${kind}`);
}

/** argv chạy thật: argv cố định của runner + cờ report + file (tương đối `cwd`). */
export function runArgv(runner, out, rels) {
  const r = RUNNERS[runner];
  return [...r.argv, ...reportArgs(r.report, out), ...rels];
}

export const SKIP_INTEGRATION =
  "test tích hợp backend (Postgres/Redis thật + dựng app Medusa) — job regression không chạy; job `gate` chạy trên HEAD";
export const SKIP_E2E =
  "E2E Playwright (cần stack chạy thật) — job regression không chạy; job `e2e` chạy trên HEAD";
export const SKIP_UNKNOWN =
  "file test không chạy ở đâu — không khớp runner nào của job regression, cũng không job CI nào chạy";

const TEST_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const UNIT_SPEC_RE = /\.unit\.spec\.[jt]s$/;

const norm = (path) => (path ?? "").trim().replaceAll("\\", "/");

/**
 * Phân loại một file đổi của PR: `{runner, rel}` (chạy được; `rel` tương đối `RUNNERS[runner].cwd`), `{skip}` (là file
 * test nhưng job không chạy — kèm lý do), hoặc null (không phải file test). Khớp testMatch/include thật của từng gói:
 * domain `src/**\/*.test.ts`; storefront `src/**\/*.test.{ts,tsx}`; backend unit `src/**\/__tests__/**\/*.unit.spec.[jt]s`,
 * `src/admin/**\/__tests__/**\/*.unit.spec.tsx`, `integration-tests/__tests__/*.unit.spec.[jt]s`; script `*.test.mjs`
 * dưới `scripts/` hoặc `e2e/` (node --test). Tích hợp = `integration-tests/http/` (TEST_TYPE=integration:http — job
 * `gate`). `src/modules/*\/__tests__/*.spec.ts` không phải `.unit.spec` khớp TEST_TYPE=integration:modules mà KHÔNG
 * workflow nào chạy → SKIP_UNKNOWN. So khớp bằng tiền tố/hậu tố chuỗi, regex không có nhóm lặp.
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
    const http = "integration-tests/http/";
    if (rel.startsWith(http) && !rel.slice(http.length).includes("/") && /\.spec\.[jt]s$/.test(rel)) {
      return { skip: SKIP_INTEGRATION };
    }
    return { skip: SKIP_UNKNOWN };
  }
  if (p.startsWith("e2e/") && p.endsWith(".spec.ts")) return { skip: SKIP_E2E };
  if ((p.startsWith("scripts/") || p.startsWith("e2e/")) && p.endsWith(".test.mjs"))
    return { runner: "node-test", rel: p };
  return { skip: SKIP_UNKNOWN };
}

/**
 * Kế hoạch chạy từ danh sách file đổi (A/C/M/R) của PR.
 * @returns {{groups: {runner: string, cwd: string, argv: string[], env: Record<string,string>, rels: string[],
 *   files: string[]}[], skipped: {file: string, reason: string}[], support: string[]}}
 *   `argv` = lệnh để in (không có cờ report); `rels` = file tương đối `cwd`; `files` = tương đối gốc repo.
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
      return { runner: k, cwd: r.cwd, argv: [...r.argv, ...rels], env: { ...r.env }, rels, files };
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

// ───────────────────────────── Report máy đọc được → test case (hàm thuần, D-153) ─────────────────────────────

/**
 * `status: "broken"` = case đỏ KHÔNG ở mức case (`why`: "nạp" — export/binding import/module chưa có trên base; "hook" —
 * hook lỗi, mọi loại hook theo D-154): không tính là tái hiện (D-153).
 * @typedef {{file: string, name: string, status: "passed" | "failed" | "skipped" | "broken", why?: "nạp" | "hook"}} TestCase
 */

const SEP = " > ";
const statusOf = (s) => (s === "passed" ? "passed" : s === "failed" ? "failed" : "skipped");

// Mọi regex dưới đây neo `^` (chỉ một vị trí bắt đầu) và các lớp ký tự liền kề rời nhau (`[\w$]` ↔ `.`/`)`/` `) → tuyến tính.
// Lời gọi named import đã biên dịch: vitest `(0 , __vite_ssr_import_0__.f)`, @swc/jest/babel `(0 , _src.f)` — chỉ trình biên
// dịch sinh dạng `(0 , X.Y)`. Nhóm 1 = X.
const COMPILED_IMPORT_CALL_RE = /^TypeError: \(0 , ([\w$]+)\.[\w$]+\) is not a (?:function|constructor)/;
// `X.Y`, `X.default.Y` (nhóm 2 rỗng) hoặc `X.a.Y`/`X.default.a.Y` (nhóm 2 = `.a`: thành viên/static method mới trên export
// đã có, vd `_src.Money.fromK`) không phải hàm/lớp. Nhóm 1 = X — xem `classifyFailure` cho điều kiện của X.
const MEMBER_NOT_CALLABLE_RE =
  /^TypeError: ([\w$]+)(?:\.default)?(\.[\w$]+)?\.[\w$]+ is not a (?:function|constructor)/;
const VITE_IMPORT_RE = /^__vi(?:te_ssr)?_import_\d+__$/;
// Module tương đối/tuyệt đối không có trên base (file mới của PR): vitest `Error: Cannot find module '/newfile' imported
// from …`, jest `Error: Cannot find module './newfile' from '…'`, node `Error [ERR_MODULE_NOT_FOUND]: Cannot find module
// '/abs/x.mjs' imported from …`. `Cannot find module 'lodash'` (gói, jest/vitest/CJS) KHÔNG khớp MODULE_NOT_FOUND_RE; còn
// header `[ERR_MODULE_NOT_FOUND]` của node khớp cả gói (`Cannot find package 'zod'`) — cố ý giữ chặt: không đọc được gói
// trên base cũng không chứng minh tái hiện. Chỉ xét đầu dòng lỗi: thông điệp assertion có trích chuỗi này (`AssertionError: expected 'Cannot find module…'`) không khớp.
const MODULE_NOT_FOUND_RE = /^(?:[\w$.]+(?: \[[A-Z_]+\])?: )?Cannot find module '\.{0,2}\//;
const ERR_MODULE_NOT_FOUND_RE = /^[\w$.]+ \[ERR_MODULE_NOT_FOUND\]: /;

/**
 * Tên binding import của một file test (nguồn bản HEAD — có mặt ở cả hai lượt chạy): namespace/default/`await import()`/
 * `require()`, và tên @swc/jest sinh cho mỗi nguồn import (`_` + tên đoạn cuối, bỏ đuôi và ký tự không phải định danh:
 * "./src" → `_src`, "../money-round.js" → `_moneyround`). Regex có tiền tố cố định, không lặp lồng → tuyến tính.
 * @param {string} source @returns {Set<string>}
 */
export function importBindings(source) {
  const out = new Set();
  const src = typeof source === "string" ? source : "";
  for (const m of src.matchAll(/\bimport\s+\*\s+as\s+([\w$]+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+([\w$]+)(?:\s*,|\s+from\b)/g)) if (m[1] !== "type") out.add(m[1]);
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g,
  )) {
    out.add(m[1]);
  }
  const sources = [
    ...src.matchAll(/\bfrom\s*["']([^"'\n]+)["']/g),
    ...src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']/g),
  ];
  for (const m of sources) {
    const last = m[1].slice(m[1].lastIndexOf("/") + 1).replace(/\.(?:[cm]?[jt]sx?|json)$/, "");
    const id = last.replace(/[^\w$]/g, "");
    if (id !== "") out.add(`_${id}`);
  }
  return out;
}

/** Các dòng frame `at …` của một stack (đã bỏ khoảng trắng hai đầu, kể cả `\r`), theo thứ tự; quét bằng indexOf. */
function* stackFrames(text) {
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf("\n", i);
    const line = text.slice(i, nl < 0 ? text.length : nl).trim();
    if (line.startsWith("at ")) yield line;
    if (nl < 0) return;
    i = nl + 1;
  }
}

/**
 * Đường dẫn file của frame `at fn (vị trí)` / `at vị trí` (bỏ `:dòng:cột`, `file://` → đường dẫn); không phải file → "".
 * Lấy ` (` ĐẦU TIÊN làm ranh giới để thư mục có ` (` vẫn đúng.
 */
export function framePath(frame) {
  let loc = String(frame ?? "").slice(3);
  const paren = loc.indexOf(" (");
  if (loc.endsWith(")") && paren >= 0) loc = loc.slice(paren + 2, -1);
  for (let k = 0; k < 2; k++) {
    const c = loc.lastIndexOf(":");
    const tail = loc.slice(c + 1);
    if (c < 0 || tail === "" || !/^\d+$/.test(tail)) break;
    loc = loc.slice(0, c);
  }
  if (loc.startsWith("file://")) {
    try {
      return norm(fileURLToPath(loc));
    } catch {
      return "";
    }
  }
  return loc.startsWith("/") || /^[A-Za-z]:[\\/]/.test(loc) ? norm(loc) : "";
}

/**
 * Frame `at …` ĐẦU TIÊN của `message` nằm trong một file của `own` (`files`: đường dẫn tương đối gốc repo `top` — file
 * test + file hỗ trợ của PR). Không có frame → false.
 * @param {string} message @param {{top?: string, files?: Iterable<string>}} own
 */
export function firstFrameInOwn(message, own) {
  const files = new Set([...(own?.files ?? [])].map(norm));
  for (const frame of stackFrames(String(message ?? ""))) {
    const p = framePath(frame);
    return p !== "" && files.has(relToTop(own?.top ?? "", p));
  }
  return false;
}

/**
 * Case đỏ vì API/module chưa có trên base ("nạp") hay vì lỗi thật (null). `message` = lỗi của case, dòng đầu là dòng lỗi
 * (`TypeError: ...`), có thể kèm stack; `bindings` = `importBindings` của file test; `own` = `{top, files}` — file test +
 * file hỗ trợ của PR (tương đối gốc repo).
 * - `(0 , X.Y)` (named import đã biên dịch) → nạp.
 * - `X.Y` / `X.default.Y` → nạp khi X là binding import (`bindings`) hoặc binding vitest `__vite_ssr_import_N__`.
 * - `X.a.Y` / `X.default.a.Y` (thành viên/static method mới trên export đã có) → nạp CHỈ khi X là binding trình biên dịch
 *   sinh: vitest `__vite_ssr_import_N__`, hoặc `_x` có trong `bindings` (@swc/jest); biến cục bộ (`cart.items.map`) → null.
 * - Mọi dạng với X do trình biên dịch sinh — `__vite_ssr_import_N__` (vitest) hoặc `_x` (@swc/jest/babel) — chỉ là nạp khi
 *   frame `at` đầu tiên nằm trong `own` (`firstFrameInOwn`): mã nguồn base cũng được biên dịch ra cùng dạng tên binding
 *   (vd plugin chưa đăng ký → `__vite_ssr_import_0__.default.utc`/`_plugin.default.utc` ném từ src; src và test cùng import
 *   "./api" → cùng `_api`), lỗi đó là lỗi thật cần tái hiện, không phải test gọi API mới.
 * - `own.compiled === false` (node --test: mã chạy nguyên bản, không trình biên dịch nào sinh tên `_x`): gốc `_x` chỉ là
 *   tên người đặt (`import * as _src`) → xử lý như mọi binding import (`_x.Y` → nạp khi có trong `bindings`; `_x.a.Y` → null),
 *   không cần frame. Chỉ gốc vitest còn ràng buộc frame.
 * - Dòng lỗi `Cannot find module './…'|'/…'` hoặc `… [ERR_MODULE_NOT_FOUND]:` → nạp.
 * @param {string} message @param {Set<string>} [bindings]
 * @param {{top?: string, files?: Iterable<string>, compiled?: boolean}} [own]
 * @returns {"nạp" | null}
 */
export function classifyFailure(message, bindings = new Set(), own = {}) {
  const msg = String(message ?? "");
  if (MODULE_NOT_FOUND_RE.test(msg) || ERR_MODULE_NOT_FOUND_RE.test(msg)) return "nạp";
  const swc = own?.compiled !== false;
  const compiled = (x) => VITE_IMPORT_RE.test(x) || (swc && x.startsWith("_"));
  const fromOwn = () => firstFrameInOwn(msg, own);
  const call = COMPILED_IMPORT_CALL_RE.exec(msg);
  if (call !== null) return !compiled(call[1]) || fromOwn() ? "nạp" : null;
  const m = MEMBER_NOT_CALLABLE_RE.exec(msg);
  if (m === null) return null;
  const [, root, member] = m;
  if (VITE_IMPORT_RE.test(root)) return fromOwn() ? "nạp" : null;
  if (!bindings.has(root)) return null;
  if (compiled(root)) return fromOwn() ? "nạp" : null;
  return member === undefined ? "nạp" : null;
}

/**
 * Case đỏ do hook (D-154: mọi hook) nhận ra từ stack — chỉ tín hiệu dương, không đầy đủ:
 * - jest-circus 29: frame `at _callCircusHook (`.
 * - vitest 5.0.5: frame `at wrapper (…/node_modules/vitest/dist/…)` — hàm bọc của beforeEach/afterEach (và hook suite) trong
 *   bundle vitest; thân test, aroundEach, fixture `test.extend` không đi qua (đã kiểm trên report thật). Report JSON của
 *   vitest KHÔNG có trường nào cho biết lỗi đến từ hook (`task.result.hooks` không được xuất).
 * GIỚI HẠN (đã kiểm, cả hai runner): hook async lỗi SAU `await` đầu tiên chỉ còn stack async (không có frame của runner) →
 * không nhận ra, case giữ `failed` (tính là tái hiện); vitest cắt stack ở 10 frame nên hook gọi sâu vào mã nguồn cũng
 * không nhận ra; tên `wrapper` là chi tiết bundle của vitest 5 — đổi phiên bản có thể mất tín hiệu (không báo nhầm, chỉ
 * mất). Giới hạn này được chấp nhận theo D-155. node --test không cần hàm này: JUnit ghi `failure type="hookFailed"`
 * (beforeEach/afterEach, node 22) hoặc `"cancelledByParent"` (case con khi `before` lỗi) — xem `HOOK_FAILURE_TYPES`.
 */
export function hookFrame(message) {
  for (const frame of stackFrames(String(message ?? ""))) {
    if (frame.startsWith("at _callCircusHook (")) return true;
    if (frame.startsWith("at wrapper (") && norm(frame).includes("/node_modules/vitest/dist/")) return true;
  }
  return false;
}

/** Bindings của `file` từ tham số `bindings` (Map file → Set, hoặc bỏ trống). */
const bindingsOf = (bindings, file) =>
  bindings instanceof Map ? (bindings.get(file) ?? new Set()) : new Set();

/** Đường dẫn tương đối gốc repo `top` (report vitest/jest ghi đường dẫn tuyệt đối). */
function relToTop(top, path) {
  const p = norm(path);
  const t = norm(top).replace(/\/$/, "");
  return t !== "" && p.startsWith(`${t}/`) ? p.slice(t.length + 1) : p;
}

/**
 * Report JSON của vitest (`--reporter=json`) hoặc jest (`--json`) — cùng khung `testResults[].assertionResults[]`.
 * File đỏ mà không case nào đỏ (lỗi nạp/biên dịch: vitest `assertionResults: []` + `message`; jest "Test suite failed to
 * run") → `loadErrors`. Case đỏ do API/module chưa có (`classifyFailure`) hoặc do hook lỗi (`hookFrame`; beforeAll lỗi thì
 * vitest đã đánh dấu các case skipped) → `broken`. `support` = file hỗ trợ test của PR (tương đối gốc repo). Sai khung →
 * ném lỗi ("không đọc được report").
 * @returns {{cases: TestCase[], loadErrors: string[]}}
 */
export function parseJestLikeJson(text, top = "", bindings = new Map(), support = []) {
  const data = JSON.parse(text);
  if (data === null || typeof data !== "object" || !Array.isArray(data.testResults)) {
    throw new Error("report JSON thiếu testResults");
  }
  const cases = [];
  const loadErrors = [];
  for (const tr of data.testResults) {
    if (tr === null || typeof tr !== "object" || typeof tr.name !== "string") {
      throw new Error("report JSON: testResults[] thiếu name");
    }
    const file = relToTop(top, tr.name);
    const asserts = Array.isArray(tr.assertionResults) ? tr.assertionResults : [];
    const msg = `${tr.message ?? ""}\n${tr.failureMessage ?? ""}`;
    const anyFailed = asserts.some((a) => a?.status === "failed");
    if ((tr.status === "failed" && !anyFailed) || msg.includes("Test suite failed to run"))
      loadErrors.push(file);
    for (const a of asserts) {
      const titles = Array.isArray(a?.ancestorTitles) ? a.ancestorTitles.map(String) : [];
      const c = { file, name: [...titles, String(a?.title ?? "")].join(SEP), status: statusOf(a?.status) };
      if (c.status === "failed") {
        const first = String((Array.isArray(a.failureMessages) ? a.failureMessages[0] : "") ?? "");
        const own = { top, files: [file, ...support] };
        const why = hookFrame(first) ? "hook" : classifyFailure(first, bindingsOf(bindings, file), own);
        if (why !== null) Object.assign(c, { status: "broken", why });
      }
      cases.push(c);
    }
  }
  return { cases, loadErrors };
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(s) {
  let out = "";
  let i = 0;
  for (;;) {
    const amp = s.indexOf("&", i);
    if (amp < 0) return out + s.slice(i);
    // Tên thực thể ngắn: chỉ tìm `;` trong 11 ký tự sau `&` (không quét tới cuối chuỗi mỗi lần → tuyến tính).
    const win = s.slice(amp + 1, amp + 12);
    const k = win.indexOf(";");
    const semi = k < 0 ? -1 : amp + 1 + k;
    const ent = k < 0 ? null : win.slice(0, k);
    let ch = null;
    if (ent !== null && Object.hasOwn(ENTITIES, ent)) ch = ENTITIES[ent];
    else if (ent !== null && ent.startsWith("#")) {
      const code = ent[1] === "x" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) ch = String.fromCodePoint(code);
    }
    if (ch === null) {
      out += s.slice(i, amp + 1);
      i = amp + 1;
    } else {
      out += s.slice(i, amp) + ch;
      i = semi + 1;
    }
  }
}

const isNameChar = (c) => c !== "" && !" \t\r\n/>=".includes(c);

/**
 * Đọc một thẻ XML bắt đầu ở `xml[lt] === "<"` bằng quét tay (tuyến tính, không regex — giá trị thuộc tính của JUnit node
 * có thể chứa `>` thô). Thẻ không đóng → null.
 * @returns {{name: string, closing: boolean, selfClosing: boolean, attrs: Record<string,string>, end: number} | null}
 */
function readTag(xml, lt) {
  let i = lt + 1;
  const closing = xml[i] === "/";
  if (closing) i++;
  const start = i;
  while (i < xml.length && isNameChar(xml[i])) i++;
  const name = xml.slice(start, i);
  const attrs = {};
  for (;;) {
    while (i < xml.length && " \t\r\n".includes(xml[i])) i++;
    if (i >= xml.length) return null;
    if (xml[i] === ">") return { name, closing, selfClosing: false, attrs, end: i + 1 };
    if (xml.startsWith("/>", i)) return { name, closing, selfClosing: true, attrs, end: i + 2 };
    const a = i;
    while (i < xml.length && isNameChar(xml[i])) i++;
    const key = xml.slice(a, i);
    if (key === "" || xml[i] !== "=") return null;
    const q = xml[i + 1];
    if (q !== '"' && q !== "'") return null;
    const close = xml.indexOf(q, i + 2);
    if (close < 0) return null;
    attrs[key] = decodeXml(xml.slice(i + 2, close));
    i = close + 1;
  }
}

// Giá trị `failureType` của node 22.22 (đã kiểm trên output JUnit thật): `hookFailed` = hook beforeEach/afterEach lỗi;
// `cancelledByParent` = case bị huỷ vì hook `before` của suite cha lỗi.
const HOOK_FAILURE_TYPES = new Set(["cancelledByParent", "hookFailed"]);

/**
 * Dòng lỗi đầu của failure JUnit node: `cause: <Loại>: <thông điệp>` trong thân (thông điệp thuộc tính không có tên loại
 * lỗi); không có → thuộc tính `message`. Quét bằng indexOf.
 */
function firstError(body, message) {
  const at = body.indexOf("cause: ");
  if (at < 0) return message;
  const end = body.indexOf("\n", at);
  return body.slice(at + "cause: ".length, end < 0 ? body.length : end).trim();
}

/** Case lỗi cấp file của node --test: tên case = đường dẫn file đã truyền (tương đối hay tuyệt đối). */
function namesFile(name, file) {
  const n = norm(name);
  const f = norm(file);
  return n !== "" && (n === f || f.endsWith(`/${n}`) || n.endsWith(`/${f}`));
}

/**
 * Report JUnit của `node --test --test-reporter=junit` cho MỘT file (`file` — tương đối gốc repo). Tên đầy đủ = tên các
 * `testsuite` (describe) lồng nhau + tên `testcase`. Case cấp cao nhất mang tên file và đỏ = lỗi nạp file → `loadErrors`.
 * Case đỏ với `failure type="hookFailed"|"cancelledByParent"` (hook lỗi) → `broken`/"hook"; lỗi `cause:` do binding import
 * hoặc module chưa có (`classifyFailure`, `bindings` của file) → `broken`/"nạp".
 * Quét tay, tuyến tính. Không có `<testsuites>`, thẻ hỏng, `testcase` không đóng → ném lỗi.
 * @returns {{cases: TestCase[], loadErrors: string[]}}
 */
export function parseJunit(xml, file, bindings = new Set()) {
  if (typeof xml !== "string" || !xml.includes("<testsuites"))
    throw new Error("report JUnit thiếu <testsuites>");
  const cases = [];
  const loadErrors = [];
  const suites = [];
  let current = null;
  const finish = (c) => {
    if (c.depth === 0 && c.status === "failed" && namesFile(c.title, file)) loadErrors.push(norm(file));
    else {
      const tc = { file: norm(file), name: c.name, status: c.status };
      if (c.status === "failed") {
        // node chạy mã nguyên bản: không có binding do trình biên dịch sinh (`compiled: false`), không cần frame.
        const why = HOOK_FAILURE_TYPES.has(c.type)
          ? "hook"
          : classifyFailure(c.first, bindings, { compiled: false });
        if (why !== null) Object.assign(tc, { status: "broken", why });
      }
      cases.push(tc);
    }
  };
  let i = 0;
  for (;;) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e < 0) throw new Error("report JUnit: chú thích không đóng");
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const e = xml.indexOf(">", lt);
      if (e < 0) throw new Error("report JUnit: khai báo không đóng");
      i = e + 1;
      continue;
    }
    const tag = readTag(xml, lt);
    if (tag === null) throw new Error("report JUnit: thẻ hỏng");
    i = tag.end;
    if (tag.name === "testsuite") {
      if (tag.closing) suites.pop();
      else if (!tag.selfClosing) suites.push(tag.attrs.name ?? "");
    } else if (tag.name === "testcase") {
      if (tag.closing) {
        if (current === null) throw new Error("report JUnit: </testcase> thừa");
        finish(current);
        current = null;
      } else {
        const title = tag.attrs.name ?? "";
        current = { title, depth: suites.length, name: [...suites, title].join(SEP), status: "passed" };
        if (tag.selfClosing) {
          finish(current);
          current = null;
        }
      }
    } else if (current !== null && !tag.closing) {
      if (tag.name === "failure" || tag.name === "error") {
        if (current.status !== "failed") {
          current.status = "failed";
          current.type = tag.attrs.type ?? "";
          let body = "";
          if (!tag.selfClosing) {
            const close = xml.indexOf(`</${tag.name}>`, i);
            if (close < 0) throw new Error("report JUnit: failure không đóng");
            body = decodeXml(xml.slice(i, close));
            i = close;
          }
          current.first = firstError(body, tag.attrs.message ?? "");
        }
      } else if (tag.name === "skipped" && current.status !== "failed") current.status = "skipped";
    }
  }
  if (current !== null) throw new Error("report JUnit: testcase không đóng (report bị cắt?)");
  return { cases, loadErrors };
}

/**
 * Phân tích report theo loại runner. `file` chỉ dùng cho JUnit (một file mỗi lần chạy); `bindings` = Map file (tương đối
 * gốc repo) → `importBindings` của file test; `support` = file hỗ trợ test của PR (`planRegression().support`).
 */
export function parseReport(kind, text, { top = "", file = "", bindings = new Map(), support = [] } = {}) {
  if (kind === "vitest-json" || kind === "jest-json")
    return parseJestLikeJson(text, top, bindings, Array.isArray(support) ? support : []);
  if (kind === "junit") return parseJunit(text, file, bindingsOf(bindings, norm(file)));
  throw new Error(`loại report không biết: ${kind}`);
}

const caseKey = (c) => `${c.file}\u0000${c.name}`;

/**
 * Test case chứng minh tái hiện (D-153): fail trên base VÀ pass trên HEAD, cùng file + tên đầy đủ.
 * @param {{cases?: TestCase[]}[]} head @param {{cases?: TestCase[]}[]} base
 * @returns {TestCase[]}
 */
export function reproducedCases(head, base) {
  const passed = new Set(
    head
      .flatMap((r) => r.cases ?? [])
      .filter((c) => c.status === "passed")
      .map(caseKey),
  );
  return base.flatMap((r) => r.cases ?? []).filter((c) => c.status === "failed" && passed.has(caseKey(c)));
}

/**
 * Quy tắc kết luận. `head`/`base`: mảng `{runner, ok, cases?, loadErrors?, readError?}` cùng thứ tự `plan.groups`
 * (null = chưa chạy).
 * 0. File test "không chạy ở đâu" (SKIP_UNKNOWN) → đỏ (ngoại lệ hợp lệ → cảnh báo); tích hợp/E2E → cảnh báo.
 * 1. Không có lệnh nào: chỉ có test tích hợp/E2E → đạt + cảnh báo; không có test → đỏ (ngoại lệ → cảnh báo).
 * 2. Một lệnh đỏ trên HEAD, hoặc không đọc được report HEAD → đỏ (không xét base, ngoại lệ không áp).
 * 3. Base: ≥ 1 test case fail trên base và pass trên HEAD → đạt. Không có → đỏ (ngoại lệ hợp lệ → cảnh báo), lý do:
 *    mọi lệnh xanh ("test không tái hiện lỗi") · đỏ mà không case nào đỏ ở mức case — lỗi nạp file, case `broken`
 *    (export/binding import/module chưa có, hook lỗi), 0 case, không đọc được report/quá hạn ("đỏ không ở mức case")
 *    · có case đỏ nhưng không case nào xanh trên HEAD cùng file + tên.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function regressionVerdict({ plan, exempt = false, head = null, base = null }) {
  const errors = [];
  const warnings = [];
  const done = () => ({ ok: errors.length === 0, errors, warnings });
  const fail = (msg) => {
    if (exempt) warnings.push(`${msg} (chấp nhận theo ngoại lệ \`${EXEMPT_LABEL}\`)`);
    else errors.push(msg);
  };
  const unknown = plan.skipped.filter((s) => s.reason === SKIP_UNKNOWN).map((s) => s.file);
  const notRun = plan.skipped.filter((s) => s.reason !== SKIP_UNKNOWN);
  warnings.push(...notRun.map((s) => `không chạy ${s.file}: ${s.reason}`));
  if (unknown.length > 0) {
    fail(
      `file test không chạy ở đâu: ${unknown.join(", ")} — không khớp runner nào (domain src/**/*.test.ts; storefront ` +
        `src/**/*.test.{ts,tsx}; backend src/**/__tests__/**/*.unit.spec.ts, integration-tests/http/*.spec.ts; ` +
        `scripts/**/*.test.mjs; e2e/*.spec.ts) nên không job CI nào chạy`,
    );
  }
  if (plan.groups.length === 0) {
    if (notRun.length > 0) {
      warnings.push(
        "PR fix chỉ có test mà job regression không chạy — 'đỏ trước' dựa vào dòng 'Đỏ trước:' của mô tả",
      );
    } else if (unknown.length === 0) {
      if (exempt) {
        warnings.push(
          `PR fix không có test mới/sửa — chấp nhận theo ngoại lệ \`${EXEMPT_LABEL}\` + 'Ngoại lệ test:'`,
        );
      } else {
        errors.push(
          `PR fix không thêm/sửa file test nào (mẫu: *.test.ts(x), *.unit.spec.ts, *.spec.ts, scripts/*.test.mjs). Thêm test ` +
            `tái hiện lỗi, hoặc nhãn \`${EXEMPT_LABEL}\` + dòng 'Ngoại lệ test: <lý do>' trong mô tả`,
        );
      }
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
  const headUnread = head.filter((r) => r.readError).map((r) => `${r.runner}: ${r.readError}`);
  if (headUnread.length > 0) {
    errors.push(`không đọc được report test trên HEAD (${headUnread.join("; ")}) — không kết luận được`);
    return done();
  }
  if (!Array.isArray(base) || base.length !== n) {
    errors.push("thiếu kết quả chạy trên base — không kết luận được");
    return done();
  }
  if (reproducedCases(head, base).length > 0) return done();
  if (base.every((r) => r.ok)) {
    fail(
      "test không tái hiện lỗi: mọi test mới/sửa của PR đều XANH trên commit base (mã chưa sửa) — test hồi quy phải đỏ trước khi sửa",
    );
    return done();
  }
  const caseRed = base.some((r) => (r.cases ?? []).some((c) => c.status === "failed"));
  if (!caseRed) {
    const why = base
      .filter((r) => !r.ok)
      .map((r) => {
        const parts = [];
        if (r.readError) parts.push(`không đọc được report: ${r.readError}`);
        if ((r.loadErrors ?? []).length > 0) parts.push(`lỗi nạp ${r.loadErrors.join(", ")}`);
        const broken = (r.cases ?? []).filter((c) => c.status === "broken");
        for (const why of ["nạp", "hook"]) {
          const n = broken.filter((c) => c.why === why).length;
          if (n > 0)
            parts.push(
              `${n} case đỏ do ${why === "nạp" ? "export/binding import/module chưa có" : "hook lỗi"}`,
            );
        }
        if ((r.cases ?? []).length === 0) parts.push("0 test case chạy");
        return `${r.runner}: ${parts.join("; ") || "không test case nào đỏ"}`;
      });
    fail(
      `base đỏ không ở mức case (nạp/hook/quá hạn), không chứng minh tái hiện (${why.join(" · ")}) — test phải chạy ` +
        "được trên mã base và đỏ ở assertion; test gọi export/module mới, hook lỗi hay quá hạn chỉ cho thấy mã base " +
        "thiếu API/không chạy được, không cho thấy lỗi",
    );
    return done();
  }
  fail(
    "base đỏ nhưng không test case nào vừa fail trên base vừa pass trên HEAD (cùng file + tên đầy đủ) — không chứng minh tái hiện",
  );
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

function runGroups(groups, top, phase, tmp, support) {
  return groups.map((g, gi) => {
    const r = RUNNERS[g.runner];
    const batches = r.perFile ? g.rels.map((rel) => [rel]) : [g.rels];
    const env = { ...process.env, ...g.env };
    // Chạy lồng trong `node --test` (test I/O) thì runner con kế thừa biến này và báo về tiến trình cha, không ghi report.
    delete env.NODE_TEST_CONTEXT;
    let ok = true;
    const notes = [];
    const cases = [];
    const loadErrors = [];
    const readErrors = [];
    // File test là bản HEAD ở cả hai lượt (base giữ file test của head) → bindings import như nhau.
    const bindings = new Map(
      g.files.map((f) => {
        let src = "";
        try {
          src = readFileSync(`${top}/${f}`, "utf8");
        } catch {
          // không đọc được nguồn → không có binding (chỉ dạng `(0 , X.Y)` được nhận ra)
        }
        return [f, importBindings(src)];
      }),
    );
    batches.forEach((rels, bi) => {
      const out = join(tmp, `${phase}-${gi}-${bi}.${r.report === "junit" ? "xml" : "json"}`);
      const argv = runArgv(g.runner, out, rels);
      console.log(`::group::[${phase}] ${r.label}: ${formatCommand({ ...g, argv: [...r.argv, ...rels] })}`);
      const res = spawnSync(argv[0], argv.slice(1), {
        cwd: g.cwd === "." ? top : `${top}/${g.cwd}`,
        env,
        stdio: "inherit",
        timeout: GROUP_TIMEOUT_MS,
      });
      console.log("::endgroup::");
      if (res.error && res.error.code !== "ETIMEDOUT") {
        // Không chạy được lệnh (vd thiếu pnpm) ≠ test đỏ: trên base nó sẽ bị tính nhầm là "tái hiện được".
        throw new Error(`không chạy được ${argv[0]}: ${res.error.message}`);
      }
      if (res.status !== 0) ok = false;
      notes.push(res.error ? `quá hạn ${GROUP_TIMEOUT_MS / 60000} phút` : `exit ${res.status ?? res.signal}`);
      const file = g.cwd === "." ? rels[0] : `${g.cwd}/${rels[0]}`;
      try {
        const parsed = parseReport(r.report, readFileSync(out, "utf8"), { top, file, bindings, support });
        cases.push(...parsed.cases);
        loadErrors.push(...parsed.loadErrors);
      } catch (e) {
        readErrors.push(`${rels.join(", ")}: ${e.message}`);
      }
    });
    const note = [...new Set(notes)].join(", ");
    const failed = cases.filter((c) => c.status === "failed").length;
    const broken = cases.filter((c) => c.status === "broken").length;
    console.log(
      `[${phase}] ${r.label}: ${ok ? "XANH" : "ĐỎ"} (${note}; ${cases.length} case, ${failed} đỏ` +
        `${broken > 0 ? `, ${broken} đỏ không ở mức case (nạp/hook)` : ""}` +
        `${loadErrors.length > 0 ? `, lỗi nạp ${loadErrors.join(", ")}` : ""}` +
        `${readErrors.length > 0 ? `, không đọc được report: ${readErrors.join("; ")}` : ""})`,
    );
    return { runner: g.runner, ok, note, cases, loadErrors, readError: readErrors.join("; ") || null };
  });
}

/**
 * Ô HEAD/base của bảng summary: số case đỏ gồm cả `broken` (đỏ không ở mức case — nạp/hook), tách riêng số broken.
 * @param {{ok: boolean, note?: string, cases?: TestCase[]} | null | undefined} r
 */
export function summaryCell(r) {
  if (!r) return "—";
  const cases = r.cases ?? [];
  const broken = cases.filter((c) => c.status === "broken").length;
  const red = cases.filter((c) => c.status === "failed").length + broken;
  const extra = broken > 0 ? `, ${broken} không ở mức case (nạp/hook)` : "";
  return `${r.ok ? "xanh" : "đỏ"} (${r.note ?? ""}; ${red}/${cases.length} case đỏ${extra})`;
}

function summary(plan, head, base, verdict) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const cell = (rs, i) => summaryCell(rs?.[i]);
  const lines = ["### regression (FE-TEST-006)", "", "| Runner | File | HEAD | base |", "|---|---|---|---|"];
  plan.groups.forEach((g, i) =>
    lines.push(
      `| ${RUNNERS[g.runner].label} | ${g.files.map((f) => `\`${f}\``).join("<br>")} | ${cell(head, i)} | ${cell(base, i)} |`,
    ),
  );
  const repro = head && base ? reproducedCases(head, base) : [];
  if (repro.length > 0) {
    lines.push("", "Test case đỏ trên base, xanh trên HEAD:");
    lines.push(...repro.slice(0, 20).map((c) => `- \`${c.file}\` — ${c.name}`));
  }
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
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "check-fix-pr-"));
    console.log(`Nếu job/lệnh bị ngắt giữa chừng, khôi phục bằng: git checkout -f ${original}`);
    git(["checkout", "--quiet", "--detach", head], top);
    headResults = runGroups(plan.groups, top, "HEAD", tmp, plan.support);
    if (headResults.every((r) => r.ok)) {
      const keep = [...plan.groups.flatMap((g) => g.files), ...plan.support];
      git(["checkout", "--quiet", "--detach", base], top);
      // --literal-pathspecs: tên file từ PR là đường dẫn nguyên văn, không phải glob/magic pathspec (`:(...)`, `*`).
      git(["--literal-pathspecs", "checkout", "--quiet", head, "--", ...keep], top);
      baseResults = runGroups(plan.groups, top, "base", tmp, plan.support);
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
      console.error(`::error::regression: không trả lại được ${original}: ${(back.stderr ?? "").trim()}`);
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
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
