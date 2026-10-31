import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RUNNERS,
  SKIP_E2E,
  SKIP_INTEGRATION,
  SKIP_UNKNOWN,
  checkFixPr,
  classifyTest,
  exemptionReason,
  fieldOf,
  formatCommand,
  isFixPr,
  isFixTitle,
  isTestFile,
  classifyFailure,
  importBindings,
  parseJestLikeJson,
  parseJunit,
  parseRegressionArgs,
  parseReport,
  planRegression,
  regressionVerdict,
  reportArgs,
  reproducedCases,
  runArgv,
} from "./check-fix-pr.mjs";

const BODY = "## Bằng chứng\nĐỏ trước: pnpm test foo — đỏ\nXanh sau: pnpm test foo — xanh\n";

test("isFixTitle: fix, fix(scope), fix! đúng; feat/fixup/rỗng/null sai", () => {
  for (const t of ["fix: a", "fix(cart): a", "fix!: a", "fix(a-b.c/d): x"])
    assert.equal(isFixTitle(t), true, t);
  for (const t of ["feat: a", "fixup: a", "fix:", "fix: ", "", null, undefined, "docs: fix: a"]) {
    assert.equal(isFixTitle(t), false, String(t));
  }
});

test("isTestFile: nhận *.test.*, *.spec.*, thư mục test, e2e; từ chối mã thường, rỗng, Windows path", () => {
  for (const f of [
    "a/b.test.ts",
    "scripts/x.test.mjs",
    "apps/storefront/src/a.spec.tsx",
    "apps/backend/integration-tests/http/x.ts",
    "e2e/cart.ts",
    "pkg/__tests__/a.ts",
    "tests/a.py",
    "svc/foo_test.go",
    "apps\\a\\b.test.ts",
  ]) {
    assert.equal(isTestFile(f), true, f);
  }
  for (const f of ["a/b.ts", "contest/a.ts", "latest.ts", "docs/test-plan.md", "", "  ", null]) {
    assert.equal(isTestFile(f), false, String(f));
  }
});

test("fieldOf: lấy giá trị dòng, bỏ chú thích HTML, Unicode, rỗng → null", () => {
  assert.equal(fieldOf(BODY, "Đỏ trước"), "pnpm test foo — đỏ");
  assert.equal(fieldOf("- Xanh sau: ok", "Xanh sau"), "ok");
  assert.equal(fieldOf("Đỏ trước:   \nkhác", "Đỏ trước"), null);
  assert.equal(fieldOf("<!-- Đỏ trước: mẫu -->", "Đỏ trước"), null);
  assert.equal(fieldOf(null, "Đỏ trước"), null);
});

test("PR không phải fix: bỏ qua dù không có test", () => {
  const r = checkFixPr({ title: "feat: x", body: "", files: ["a.ts"] });
  assert.deepEqual(r, { ok: true, skipped: true, errors: [] });
});

test("PR fix: có file test + đỏ/xanh → đạt", () => {
  const r = checkFixPr({ title: "fix(cart): x", body: BODY, files: ["a.ts", "a.test.ts"] });
  assert.equal(r.ok, true);
});

test("PR fix: không đổi file test → đỏ", () => {
  const r = checkFixPr({ title: "fix: x", body: BODY, files: ["a.ts"] });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /file test/);
});

test("PR fix: danh sách file rỗng → đỏ", () => {
  assert.equal(checkFixPr({ title: "fix: x", body: BODY, files: [] }).ok, false);
});

test("PR fix: thiếu đỏ trước hoặc xanh sau → đỏ, nêu đúng mục thiếu", () => {
  const r = checkFixPr({ title: "fix: x", body: "Đỏ trước: có\n", files: ["a.test.ts"] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Xanh sau/);
  const r2 = checkFixPr({ title: "fix: x", body: "", files: ["a.test.ts"] });
  assert.equal(r2.errors.length, 2);
});

test("ngoại lệ: nhãn + lý do đủ dài → đạt; thiếu lý do hoặc quá ngắn → đỏ; không nhãn thì lý do vô hiệu", () => {
  const labels = ["fix-no-test"];
  const ok = checkFixPr({
    title: "fix: x",
    body: "Ngoại lệ test: chỉ sửa lỗi chính tả trong tài liệu",
    labels,
    files: ["README.md"],
  });
  assert.equal(ok.ok, true);
  assert.equal(checkFixPr({ title: "fix: x", body: "", labels, files: [] }).ok, false);
  assert.equal(checkFixPr({ title: "fix: x", body: "Ngoại lệ test: ngắn", labels, files: [] }).ok, false);
  const noLabel = checkFixPr({
    title: "fix: x",
    body: "Ngoại lệ test: chỉ sửa lỗi chính tả trong tài liệu",
    files: ["README.md"],
  });
  assert.equal(noLabel.ok, false);
});

// ───────────────────────────── --regression (T-209, FE-TEST-006) ─────────────────────────────

test("isFixPr: CHỈ theo tiêu đề PR (D-152) — PR feat có commit fix: dọc đường → bỏ qua", () => {
  for (const t of ["fix(cart): a", "fix: a", "fix!: a"]) assert.equal(isFixPr(t), true, t);
  // Đối số thứ hai (danh sách subject commit) bị bỏ qua có chủ đích: tiêu đề feat → không phải PR fix.
  assert.equal(isFixPr("feat: a", ["chore: b", "fix(ui): c"]), false);
  for (const t of ["feat: a", "fixup: a", 'Revert "fix: d"', "fix:", "", null, undefined]) {
    assert.equal(isFixPr(t), false, String(t));
  }
});

test("classifyTest: runner theo vị trí, khớp testMatch/include thật của từng gói", () => {
  assert.deepEqual(classifyTest("packages/domain/src/money/x.test.ts"), {
    runner: "vitest-domain",
    rel: "src/money/x.test.ts",
  });
  assert.deepEqual(classifyTest("apps/storefront/src/lib/cart/service.test.ts"), {
    runner: "vitest-storefront",
    rel: "src/lib/cart/service.test.ts",
  });
  assert.equal(classifyTest("apps/storefront/src/app/page.test.tsx").runner, "vitest-storefront");
  assert.deepEqual(classifyTest("apps/backend/src/lib/http/__tests__/pagination.unit.spec.ts"), {
    runner: "jest-backend-unit",
    rel: "src/lib/http/__tests__/pagination.unit.spec.ts",
  });
  assert.equal(
    classifyTest("apps/backend/src/admin/lib/__tests__/a.unit.spec.tsx").runner,
    "jest-backend-unit",
  );
  assert.equal(
    classifyTest("apps/backend/integration-tests/__tests__/lease.unit.spec.ts").runner,
    "jest-backend-unit",
  );
  assert.deepEqual(classifyTest("scripts/check-x.test.mjs"), {
    runner: "node-test",
    rel: "scripts/check-x.test.mjs",
  });
  assert.equal(classifyTest("scripts/ops/a.test.mjs").runner, "node-test");
  assert.equal(classifyTest("e2e/smoke-tags.test.mjs").runner, "node-test");
  assert.equal(classifyTest("apps\\storefront\\src\\a.test.ts").runner, "vitest-storefront");
});

test("classifyTest: tích hợp/E2E/không khớp runner → skip có lý do; mã thường → null", () => {
  assert.deepEqual(classifyTest("apps/backend/integration-tests/http/refunds.spec.ts"), {
    skip: SKIP_INTEGRATION,
  });
  assert.deepEqual(classifyTest("e2e/checkout-cod.spec.ts"), { skip: SKIP_E2E });
  for (const f of [
    // TEST_TYPE=integration:modules khớp file này nhưng không workflow nào chạy nó (ci.yml chỉ integration:http).
    "apps/backend/src/modules/settlement/__tests__/svc.spec.ts",
    "apps/backend/integration-tests/http/sub/x.spec.ts", // testMatch http chỉ một cấp
    "apps/backend/integration-tests/http/x.test.ts", // testMatch http chỉ *.spec
    "apps/backend/src/lib/price.unit.spec.ts", // ngoài __tests__
    "apps/storefront/src/lib/cart.spec.ts", // storefront chỉ *.test.{ts,tsx}
    "docs/x.test.js",
    "apps/backend/src/lib/__tests__/a.spec.ts", // không phải .unit.spec → ngoài testMatch unit
    "apps/backend/src/lib/__tests__/a.unit.spec.tsx", // tsx ngoài src/admin
    "apps/backend/src/lib/a.unit.spec.ts", // ngoài __tests__
    "apps/backend/integration-tests/__tests__/sub/a.unit.spec.ts", // testMatch chỉ một cấp
    "packages/domain/src/a.test.tsx",
    "apps/storefront/src/a.spec.ts",
    "apps/storefront/scripts/a.test.mjs",
    "scripts/../x.test.mjs",
    "/scripts/x.test.mjs",
    "-x.test.mjs",
  ]) {
    assert.deepEqual(classifyTest(f), { skip: SKIP_UNKNOWN }, f);
  }
  for (const f of [
    "apps/backend/src/lib/http/pagination.ts",
    "scripts/check-x.mjs",
    "README.md",
    "",
    null,
    undefined,
  ]) {
    assert.equal(classifyTest(f), null, String(f));
  }
});

test("planRegression: gom theo runner (thứ tự cố định), đường dẫn tương đối cwd, bỏ trùng/rỗng, file hỗ trợ __tests__", () => {
  const plan = planRegression([
    "scripts/b.test.mjs",
    "apps/backend/src/lib/http/pagination.ts",
    "apps/storefront/src/z.test.tsx",
    "scripts/a.test.mjs",
    "scripts/a.test.mjs",
    "",
    "apps/backend/src/lib/outbox/__tests__/fake-outbox-store.ts",
    "apps/backend/src/lib/outbox/__tests__/relay.unit.spec.ts",
    "apps/backend/integration-tests/http/x.spec.ts",
  ]);
  assert.deepEqual(
    plan.groups.map((g) => g.runner),
    ["vitest-storefront", "jest-backend-unit", "node-test"],
  );
  const [sf, be, node] = plan.groups;
  assert.equal(sf.cwd, "apps/storefront");
  assert.deepEqual(sf.argv, ["node", "scripts/test.mjs", "src/z.test.tsx"]);
  assert.deepEqual(sf.files, ["apps/storefront/src/z.test.tsx"]);
  assert.deepEqual(be.argv, [
    "pnpm",
    "exec",
    "jest",
    "--runInBand",
    "--forceExit",
    "--runTestsByPath",
    "src/lib/outbox/__tests__/relay.unit.spec.ts",
  ]);
  assert.deepEqual(be.env, { TEST_TYPE: "unit", NODE_OPTIONS: "--experimental-vm-modules" });
  assert.ok(!be.argv.includes("--passWithNoTests"));
  assert.deepEqual(node.argv, ["node", "--test", "scripts/a.test.mjs", "scripts/b.test.mjs"]);
  assert.deepEqual(node.files, ["scripts/a.test.mjs", "scripts/b.test.mjs"]);
  assert.deepEqual(plan.skipped, [
    { file: "apps/backend/integration-tests/http/x.spec.ts", reason: SKIP_INTEGRATION },
  ]);
  assert.deepEqual(plan.support, ["apps/backend/src/lib/outbox/__tests__/fake-outbox-store.ts"]);
});

test("planRegression: rỗng/không có test → không nhóm nào; env nhóm là bản sao (không sửa được RUNNERS)", () => {
  assert.deepEqual(planRegression([]), { groups: [], skipped: [], support: [] });
  assert.deepEqual(planRegression(), { groups: [], skipped: [], support: [] });
  const p = planRegression(["apps/backend/src/lib/__tests__/a.unit.spec.ts"]);
  p.groups[0].env.TEST_TYPE = "integration:http";
  assert.equal(RUNNERS["jest-backend-unit"].env.TEST_TYPE, "unit");
});

test("formatCommand: cd + env + argv, trích dẫn ký tự đặc biệt; gốc repo không cd", () => {
  const p = planRegression(["apps/backend/src/lib/__tests__/a b.unit.spec.ts", "scripts/it's.test.mjs"]);
  assert.equal(
    formatCommand(p.groups[0]),
    "(cd apps/backend && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand --forceExit " +
      "--runTestsByPath 'src/lib/__tests__/a b.unit.spec.ts')",
  );
  assert.equal(formatCommand(p.groups[1]), "node --test 'scripts/it'\\''s.test.mjs'");
});

const PLAN2 = planRegression(["scripts/a.test.mjs", "apps/storefront/src/a.test.ts"]);
/** Kết quả một lần chạy: mỗi nhóm một case cùng tên; nhóm xanh → case pass, nhóm đỏ → case fail (assertion). */
const caseOf = (i, status, name = "nhóm > ca") => ({ file: PLAN2.groups[i].files[0], name, status });
const res = (...oks) =>
  oks.map((ok, i) => ({
    runner: PLAN2.groups[i].runner,
    ok,
    note: `exit ${ok ? 0 : 1}`,
    cases: [caseOf(i, ok ? "passed" : "failed")],
    loadErrors: [],
    readError: null,
  }));

test("regressionVerdict: HEAD xanh + base có ít nhất một test case đỏ (cùng file + tên xanh trên HEAD) → đạt", () => {
  assert.deepEqual(regressionVerdict({ plan: PLAN2, head: res(true, true), base: res(true, false) }), {
    ok: true,
    errors: [],
    warnings: [],
  });
  assert.equal(regressionVerdict({ plan: PLAN2, head: res(true, true), base: res(false, false) }).ok, true);
});

test("regressionVerdict: mọi test xanh trên base → đỏ 'test không tái hiện lỗi'; ngoại lệ → chỉ cảnh báo", () => {
  const r = regressionVerdict({ plan: PLAN2, head: res(true, true), base: res(true, true) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /test không tái hiện lỗi/);
  const ex = regressionVerdict({ plan: PLAN2, exempt: true, head: res(true, true), base: res(true, true) });
  assert.equal(ex.ok, true);
  assert.match(ex.warnings[0], /không tái hiện lỗi.*fix-no-test/);
});

test("regressionVerdict: đỏ trên HEAD → đỏ kể cả có ngoại lệ, nêu runner đỏ; không cần kết quả base", () => {
  for (const exempt of [false, true]) {
    const r = regressionVerdict({ plan: PLAN2, exempt, head: res(true, false), base: null });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /ĐỎ trên HEAD \(node-test\)/);
  }
});

test("regressionVerdict: thiếu/lệch số kết quả → đỏ 'không kết luận được' (không bao giờ đạt nhầm)", () => {
  assert.match(regressionVerdict({ plan: PLAN2 }).errors[0], /HEAD — không kết luận/);
  assert.match(regressionVerdict({ plan: PLAN2, head: res(true) }).errors[0], /HEAD — không kết luận/);
  assert.match(
    regressionVerdict({ plan: PLAN2, head: res(true, true), base: [] }).errors[0],
    /base — không kết luận/,
  );
});

test("regressionVerdict: không có test → đỏ; ngoại lệ hợp lệ → đạt + cảnh báo; chỉ test tích hợp/E2E → đạt + cảnh báo", () => {
  const empty = planRegression(["apps/backend/src/lib/http/pagination.ts"]);
  const r = regressionVerdict({ plan: empty });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /không thêm\/sửa file test/);
  const ex = regressionVerdict({ plan: empty, exempt: true });
  assert.equal(ex.ok, true);
  assert.equal(ex.warnings.length, 1);
  const integ = planRegression(["apps/backend/integration-tests/http/x.spec.ts", "e2e/a.spec.ts"]);
  const ri = regressionVerdict({ plan: integ });
  assert.equal(ri.ok, true);
  assert.equal(ri.warnings.length, 3);
  assert.match(ri.warnings[2], /Đỏ trước:/);
});

test("exemptionReason: cần cả nhãn và lý do ≥ 10 ký tự", () => {
  const body = "Ngoại lệ test: chỉ đổi thông điệp lỗi hiển thị";
  assert.equal(exemptionReason({ body, labels: ["fix-no-test"] }), "chỉ đổi thông điệp lỗi hiển thị");
  assert.equal(exemptionReason({ body, labels: [] }), null);
  assert.equal(exemptionReason({ body: "Ngoại lệ test: ngắn", labels: ["fix-no-test"] }), null);
  assert.equal(exemptionReason({ body: undefined, labels: ["fix-no-test"] }), null);
});

test("parseRegressionArgs: cần --base và --head; từ chối giá trị rỗng/bắt đầu bằng '-' và tham số lạ", () => {
  assert.deepEqual(parseRegressionArgs(["--regression", "--base", "abc", "--head", "def", "--dry-run"]), {
    base: "abc",
    head: "def",
    dryRun: true,
  });
  assert.throws(() => parseRegressionArgs(["--base", "abc"]), /cần --base/);
  assert.throws(() => parseRegressionArgs(["--base", "--head", "x"]), /--base cần/);
  assert.throws(() => parseRegressionArgs(["--base", "", "--head", "x"]), /--base cần/);
  assert.throws(() => parseRegressionArgs(["--base", "a", "--head", "b", "--force"]), /không biết/);
});

// ───────────────────────────── file test "không chạy ở đâu" (SKIP_UNKNOWN) → đỏ ─────────────────────────────

test("regressionVerdict: file test không chạy ở đâu → đỏ (3 ca tái hiện + đường dẫn bị loại); ngoại lệ → cảnh báo", () => {
  for (const f of [
    "apps/backend/src/lib/price.unit.spec.ts",
    "apps/storefront/src/lib/cart.spec.ts",
    "docs/x.test.js",
    "apps/backend/src/modules/settlement/__tests__/svc.spec.ts",
    "scripts/../x.test.mjs",
  ]) {
    const plan = planRegression([f, "apps/backend/src/lib/price.ts"]);
    assert.equal(plan.groups.length, 0, f);
    const r = regressionVerdict({ plan });
    assert.equal(r.ok, false, f);
    assert.equal(r.errors.length, 1, f);
    assert.match(r.errors[0], /file test không chạy ở đâu: /, f);
    assert.ok(r.errors[0].includes(f.replaceAll("\\", "/")), f);
    const ex = regressionVerdict({ plan, exempt: true });
    assert.equal(ex.ok, true, f);
    assert.match(ex.warnings.join("\n"), /không chạy ở đâu.*fix-no-test/, f);
  }
});

test("regressionVerdict: test chạy được + một file 'không chạy ở đâu' → vẫn đỏ dù base tái hiện được", () => {
  const plan = planRegression(["scripts/a.test.mjs", "apps/storefront/src/lib/cart.spec.ts"]);
  assert.equal(plan.groups.length, 1);
  const ok = [
    { runner: "node-test", ok: true, cases: [{ file: "scripts/a.test.mjs", name: "a", status: "passed" }] },
  ];
  const red = [
    { runner: "node-test", ok: false, cases: [{ file: "scripts/a.test.mjs", name: "a", status: "failed" }] },
  ];
  const r = regressionVerdict({ plan, head: ok, base: red });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /không chạy ở đâu: apps\/storefront\/src\/lib\/cart\.spec\.ts/);
});

test("regressionVerdict: tích hợp/E2E + file không chạy ở đâu → đỏ (tích hợp chỉ cứu chính nó)", () => {
  const plan = planRegression(["apps/backend/integration-tests/http/x.spec.ts", "docs/x.test.js"]);
  const r = regressionVerdict({ plan });
  assert.equal(r.ok, false);
  assert.match(r.warnings[0], /integration-tests\/http\/x\.spec\.ts/);
});

// ───────────────────────────── report máy đọc được (D-153) ─────────────────────────────

const TOP = "/repo";
const VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  success: false,
  testResults: [
    {
      name: "/repo/packages/domain/src/money/a.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["tiền", "làm tròn"],
          title: "đúng",
          fullName: "tiền làm tròn đúng",
          status: "passed",
        },
        {
          ancestorTitles: ["tiền", "làm tròn"],
          title: "sai",
          fullName: "tiền làm tròn sai",
          status: "failed",
        },
        { ancestorTitles: [], title: "bỏ", fullName: "bỏ", status: "skipped" },
        { ancestorTitles: [], title: "chưa", fullName: "chưa", status: "todo" },
      ],
    },
    {
      name: "/repo/packages/domain/src/money/b.test.ts",
      status: "failed",
      message: "Cannot find module './missing' imported from /repo/packages/domain/src/money/b.test.ts",
      assertionResults: [],
    },
  ],
});

const JEST_JSON = JSON.stringify({
  numRuntimeErrorTestSuites: 1,
  success: false,
  testResults: [
    {
      name: "/repo/apps/backend/src/lib/__tests__/a.unit.spec.ts",
      status: "failed",
      message: "  ● nhóm › sai\n\n    expect(received).toBe(expected)",
      assertionResults: [
        { ancestorTitles: ["nhóm"], title: "đúng", fullName: "nhóm đúng", status: "passed" },
        { ancestorTitles: ["nhóm"], title: "sai", fullName: "nhóm sai", status: "failed" },
        { ancestorTitles: ["nhóm"], title: "chờ", fullName: "nhóm chờ", status: "pending" },
      ],
    },
    {
      name: "/repo/apps/backend/src/lib/__tests__/b.unit.spec.ts",
      status: "failed",
      message: "  ● Test suite failed to run\n\n    Cannot find module './missing'",
      assertionResults: [],
    },
  ],
});

// Mẫu thật của node 22.22.0 `--test-reporter=junit` (rút gọn): `>` thô trong thuộc tính, `&lt;`, describe lồng nhau.
const JUNIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="nhóm" time="0.002" disabled="0" errors="0" tests="3" failures="1" skipped="1" hostname="vm">
		<testcase name="cộng &lt;đúng>" time="0.0006" classname="test"/>
		<testcase name="sai" time="0.0008" classname="test" failure="1 !== 2">
			<failure type="testCodeFailure" message="1 !== 2">
Error [ERR_TEST_FAILURE]: 1 !== 2
    at TestContext.&lt;anonymous> (file:///repo/scripts/a.test.mjs:3:100)
			</failure>
		</testcase>
		<testsuite name="con" time="0.001" tests="1" failures="0" skipped="0">
			<testcase name="lồng" time="0.0001" classname="test"/>
		</testsuite>
		<testcase name="bỏ" time="0" classname="test">
			<skipped type="skipped" message="true"/>
		</testcase>
	</testsuite>
	<testcase name="đỉnh &amp; &#273;&#x1ea1;i" time="0.0002" classname="test"/>
	<!-- tests 5 -->
</testsuites>
`;

const JUNIT_LOAD = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="scripts/b.test.mjs" time="0.033" classname="test" failure="test failed">
		<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure' }
		</failure>
	</testcase>
	<!-- tests 1 -->
</testsuites>
`;

test("parseJestLikeJson (vitest): case = file tương đối gốc repo + describe > tên; file đỏ không case → lỗi nạp", () => {
  const r = parseJestLikeJson(VITEST_JSON, TOP);
  const f = "packages/domain/src/money/a.test.ts";
  assert.deepEqual(r.cases, [
    { file: f, name: "tiền > làm tròn > đúng", status: "passed" },
    { file: f, name: "tiền > làm tròn > sai", status: "failed" },
    { file: f, name: "bỏ", status: "skipped" },
    { file: f, name: "chưa", status: "skipped" },
  ]);
  assert.deepEqual(r.loadErrors, ["packages/domain/src/money/b.test.ts"]);
  assert.deepEqual(parseReport("vitest-json", VITEST_JSON, { top: `${TOP}/` }), r);
});

test("parseJestLikeJson (jest): 'Test suite failed to run' → lỗi nạp; pending → skipped", () => {
  const r = parseJestLikeJson(JEST_JSON, TOP);
  assert.deepEqual(
    r.cases.map((c) => [c.file, c.name, c.status]),
    [
      ["apps/backend/src/lib/__tests__/a.unit.spec.ts", "nhóm > đúng", "passed"],
      ["apps/backend/src/lib/__tests__/a.unit.spec.ts", "nhóm > sai", "failed"],
      ["apps/backend/src/lib/__tests__/a.unit.spec.ts", "nhóm > chờ", "skipped"],
    ],
  );
  assert.deepEqual(r.loadErrors, ["apps/backend/src/lib/__tests__/b.unit.spec.ts"]);
  // Đường dẫn ngoài top giữ nguyên; Windows path chuẩn hoá.
  const win = JSON.stringify({
    testResults: [{ name: "C:\\r\\x.test.ts", status: "passed", assertionResults: [] }],
  });
  assert.deepEqual(parseJestLikeJson(win, "C:\\r").cases, []);
  assert.deepEqual(parseJestLikeJson(win, "/khác").loadErrors, []);
});

test("parseJestLikeJson: không đọc được (rỗng, JSON hỏng, thiếu testResults/name) → ném lỗi", () => {
  for (const t of [
    "",
    "{",
    "null",
    "[]",
    '{"testResults": 1}',
    '{"testResults": [{}]}',
    '{"testResults": [null]}',
  ]) {
    assert.throws(() => parseJestLikeJson(t, TOP), Error, t);
  }
});

test("parseJunit (node --test): tên đầy đủ theo describe lồng, giải mã thực thể, `>` thô trong thuộc tính, skipped", () => {
  const r = parseJunit(JUNIT_XML, "scripts/a.test.mjs");
  assert.deepEqual(
    r.cases.map((c) => [c.name, c.status]),
    [
      ["nhóm > cộng <đúng>", "passed"],
      ["nhóm > sai", "failed"],
      ["nhóm > con > lồng", "passed"],
      ["nhóm > bỏ", "skipped"],
      ["đỉnh & đại", "passed"],
    ],
  );
  assert.ok(r.cases.every((c) => c.file === "scripts/a.test.mjs"));
  assert.deepEqual(r.loadErrors, []);
  assert.deepEqual(parseReport("junit", JUNIT_XML, { file: "scripts/a.test.mjs" }), r);
});

test("parseJunit: case cấp cao nhất mang tên file và đỏ → lỗi nạp (không phải case); tên trùng nhưng xanh/lồng → case", () => {
  assert.deepEqual(parseJunit(JUNIT_LOAD, "scripts/b.test.mjs"), {
    cases: [],
    loadErrors: ["scripts/b.test.mjs"],
  });
  // node có thể ghi đường dẫn tuyệt đối hoặc tương đối cwd.
  const abs = JUNIT_LOAD.replace('name="scripts/b.test.mjs"', 'name="/w/repo/scripts/b.test.mjs"');
  assert.deepEqual(parseJunit(abs, "scripts/b.test.mjs").loadErrors, ["scripts/b.test.mjs"]);
  const green = '<testsuites><testcase name="scripts/b.test.mjs"/></testsuites>';
  assert.equal(parseJunit(green, "scripts/b.test.mjs").cases.length, 1);
  const nested =
    '<testsuites><testsuite name="s"><testcase name="b.test.mjs"><failure/></testcase></testsuite></testsuites>';
  assert.deepEqual(parseJunit(nested, "scripts/b.test.mjs").cases, [
    { file: "scripts/b.test.mjs", name: "s > b.test.mjs", status: "failed" },
  ]);
  assert.deepEqual(parseJunit("<testsuites>\n</testsuites>", "scripts/b.test.mjs"), {
    cases: [],
    loadErrors: [],
  });
});

test("parseJunit: không đọc được (rỗng, thiếu <testsuites>, thẻ hỏng, testcase không đóng) → ném lỗi", () => {
  for (const x of [
    "",
    null,
    "<testsuite></testsuite>",
    '<testsuites><testcase name="a"',
    '<testsuites><testcase name="a">',
    "<testsuites><testcase name=a/></testsuites>",
    "<testsuites></testcase></testsuites>",
    "<testsuites><!-- tests 1",
    JUNIT_XML.slice(0, JUNIT_XML.indexOf("</testcase>")),
  ]) {
    assert.throws(() => parseJunit(x, "scripts/a.test.mjs"), Error, String(x));
  }
  assert.throws(() => parseReport("tap", "", {}), /không biết/);
});

test("parseJunit/parseJestLikeJson: đầu vào bệnh lý lớn chạy tuyến tính (chống ReDoS)", () => {
  const n = 200_000;
  const inputs = [
    `<testsuites>${"<testcase name='".repeat(n)}`,
    `<testsuites><testcase name="${"&".repeat(n)}"/></testsuites>`,
    `<testsuites><testcase name="${"&#".repeat(n)}"/></testsuites>`,
    `<testsuites>${'<testcase a="x" '.repeat(n)}`,
    `<testsuites>${"<".repeat(n)}</testsuites>`,
  ];
  const t0 = Date.now();
  for (const x of inputs) {
    try {
      parseJunit(x, "scripts/a.test.mjs");
    } catch {
      // đầu vào hỏng được phép ném — chỉ đo thời gian
    }
  }
  assert.ok(Date.now() - t0 < 2000, `quá chậm: ${Date.now() - t0} ms`);
});

test("reportArgs/runArgv: cờ report đúng từng runner, đặt trước danh sách file; loại lạ → ném lỗi", () => {
  assert.deepEqual(runArgv("vitest-domain", "/t/o.json", ["src/a.test.ts"]), [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--reporter=default",
    "--reporter=json",
    "--outputFile.json=/t/o.json",
    "src/a.test.ts",
  ]);
  assert.deepEqual(runArgv("vitest-storefront", "/t/o.json", ["src/a.test.tsx"]).slice(2, 5), [
    "--reporter=default",
    "--reporter=json",
    "--outputFile.json=/t/o.json",
  ]);
  assert.deepEqual(runArgv("jest-backend-unit", "/t/o.json", ["src/x.unit.spec.ts"]).slice(-3), [
    "--json",
    "--outputFile=/t/o.json",
    "src/x.unit.spec.ts",
  ]);
  assert.deepEqual(runArgv("node-test", "/t/o.xml", ["scripts/a.test.mjs"]), [
    "node",
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    "--test-reporter-destination=/t/o.xml",
    "scripts/a.test.mjs",
  ]);
  assert.equal(RUNNERS["node-test"].perFile, true);
  assert.throws(() => reportArgs("tap", "/t/o"), /không biết/);
});

test("reproducedCases: chỉ case fail trên base VÀ pass trên HEAD, cùng file + tên", () => {
  const c = (file, name, status) => ({ file, name, status });
  const head = [{ cases: [c("a", "x", "passed"), c("a", "y", "passed"), c("b", "x", "skipped")] }, {}];
  const base = [
    { cases: [c("a", "x", "failed"), c("a", "y", "passed"), c("b", "x", "failed"), c("c", "x", "failed")] },
    { cases: [c("a", "z", "failed")] },
  ];
  assert.deepEqual(reproducedCases(head, base), [c("a", "x", "failed")]);
  assert.deepEqual(reproducedCases([], []), []);
});

test("regressionVerdict: base đỏ không ở mức case (0 case / lỗi nạp / case broken / không đọc được report) → đỏ; ngoại lệ → cảnh báo", () => {
  const head = res(true, true);
  const variants = [
    { cases: [], loadErrors: [PLAN2.groups[1].files[0]], readError: null },
    { cases: [], loadErrors: [], readError: null },
    { cases: [], loadErrors: [], readError: "ENOENT" },
    // file khác đỏ do nạp, case còn lại xanh
    { cases: [caseOf(1, "passed")], loadErrors: [PLAN2.groups[1].files[0]], readError: null },
    // case đỏ vì export mới chưa có trên base / vì hook cha lỗi
    { cases: [{ ...caseOf(1, "broken"), why: "nạp" }], loadErrors: [], readError: null },
    { cases: [{ ...caseOf(1, "broken"), why: "hook" }], loadErrors: [], readError: null },
  ];
  for (const v of variants) {
    const base = [res(true, true)[0], { runner: PLAN2.groups[1].runner, ok: false, note: "exit 1", ...v }];
    const r = regressionVerdict({ plan: PLAN2, head, base });
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(
      r.errors[0],
      /base đỏ không ở mức case \(nạp\/hook\/quá hạn\), không chứng minh tái hiện/,
      JSON.stringify(v),
    );
    const ex = regressionVerdict({ plan: PLAN2, exempt: true, head, base });
    assert.equal(ex.ok, true);
    assert.match(ex.warnings[0], /đỏ không ở mức case.*fix-no-test/);
  }
});

test("regressionVerdict: base có case đỏ nhưng không case nào xanh trên HEAD cùng file + tên → đỏ", () => {
  const head = res(true, true);
  const base = res(true, false).map((r, i) => ({
    ...r,
    cases: [caseOf(i, r.ok ? "passed" : "failed", "tên khác")],
  }));
  const r = regressionVerdict({ plan: PLAN2, head, base });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /không test case nào vừa fail trên base vừa pass trên HEAD/);
});

test("regressionVerdict: không đọc được report trên HEAD → đỏ 'không kết luận được' kể cả có ngoại lệ", () => {
  const head = res(true, true).map((r, i) => (i === 0 ? { ...r, cases: [], readError: "JSON hỏng" } : r));
  for (const exempt of [false, true]) {
    const r = regressionVerdict({ plan: PLAN2, exempt, head, base: res(false, false) });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /không đọc được report test trên HEAD \(vitest-storefront: JSON hỏng\)/);
  }
});

// ───────────────────────────── --regression: I/O trên repo git tạm (node --test) ─────────────────────────────

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-fix-pr.mjs");
const GIT_ID = [
  "-c",
  "user.name=fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

/** Env con không mang `GIT_*` của tiến trình ngoài (GIT_DIR, GIT_INDEX_FILE… khi chạy trong hook) — git chỉ thấy repo tạm. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function g(cwd, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function commitAll(dir, msg) {
  g(dir, "add", "-A");
  g(dir, ...GIT_ID, "commit", "-q", "-m", msg);
  return g(dir, "rev-parse", "HEAD");
}

/**
 * Repo tạm: commit base (mã `lib`), commit head (mã `lib` mới + file test), nhánh `work` = head. Trả {dir, base, head}.
 * @param {string} baseLib @param {string} headLib @param {string} testSrc
 */
function fixtureRepo(t, baseLib, headLib, testSrc) {
  const dir = mkdtempSync(join(tmpdir(), "check-fix-pr-io-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  g(dir, "init", "-q");
  g(dir, "checkout", "-q", "-b", "work");
  write(dir, "scripts/lib.mjs", baseLib);
  write(dir, "README.md", "fixture\n");
  const base = commitAll(dir, "chore: base");
  write(dir, "scripts/lib.mjs", headLib);
  write(dir, "scripts/lib.test.mjs", testSrc);
  const head = commitAll(dir, "fix: sửa cộng");
  return { dir, base, head };
}

function runRegression(dir, base, head, extraEnv = {}) {
  const env = cleanEnv({ PR_TITLE: "fix(lib): sửa cộng", PR_BODY: "", PR_LABELS: "[]", ...extraEnv });
  for (const k of ["NODE_TEST_CONTEXT", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) delete env[k];
  return spawnSync(process.execPath, [SCRIPT, "--regression", "--base", base, "--head", head], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const TEST_ADD = `import assert from "node:assert/strict";
import { test } from "node:test";
import { add } from "./lib.mjs";
test("cộng hai số", () => assert.equal(add(1, 2), 3));
`;
const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

function assertBackOnWork(dir) {
  assert.equal(g(dir, "symbolic-ref", "--short", "HEAD"), "work");
  assert.equal(g(dir, "status", "--porcelain"), "");
}

test("--regression I/O: base đỏ ở assertion, HEAD xanh → exit 0; trả lại nhánh ban đầu", (t) => {
  const { dir, base, head } = fixtureRepo(t, BUGGY, FIXED, TEST_ADD);
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /khôi phục bằng: git checkout -f work/);
  assert.match(r.stdout, /OK — regression đạt/);
  assertBackOnWork(dir);
});

test("--regression I/O: base đỏ do nạp file (named import export mới) → exit 1 'đỏ không ở mức case'", (t) => {
  const testSum = TEST_ADD.replace("{ add }", "{ add, sum }").replace("add(1, 2), 3", "sum([1, 2]), 3");
  const { dir, base, head } = fixtureRepo(
    t,
    FIXED,
    `${FIXED}export const sum = (xs) => xs.reduce(add, 0);\n`,
    testSum,
  );
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /đỏ không ở mức case \(nạp\/hook\/quá hạn\)/);
  assert.match(r.stderr, /lỗi nạp scripts\/lib\.test\.mjs/);
  assertBackOnWork(dir);
});

test("--regression I/O: base đỏ vì gọi export mới qua namespace import (case chạy, TypeError) → exit 1", (t) => {
  const testNs = `import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "./lib.mjs";
test("tổng", () => assert.equal(lib.sum([1, 2]), 3));
`;
  const { dir, base, head } = fixtureRepo(
    t,
    FIXED,
    `${FIXED}export const sum = (xs) => xs.reduce(add, 0);\n`,
    testNs,
  );
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /đỏ không ở mức case.*1 case đỏ do export\/binding import chưa có/);
  assertBackOnWork(dir);
});

test("--regression I/O: test xanh cả trên base → exit 1 'không tái hiện lỗi'", (t) => {
  const { dir, base, head } = fixtureRepo(t, FIXED, `${FIXED}// sửa chú thích\n`, TEST_ADD);
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /test không tái hiện lỗi/);
  assertBackOnWork(dir);
});

test("--regression I/O: test đỏ trên HEAD → exit 1, không chạy base", (t) => {
  const { dir, base, head } = fixtureRepo(t, BUGGY, `${BUGGY}// chưa sửa\n`, TEST_ADD);
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ĐỎ trên HEAD \(node-test\)/);
  assert.doesNotMatch(r.stdout, /\[base\]/);
  assertBackOnWork(dir);
});

test("--regression I/O: cây làm việc bẩn → exit 2, không checkout, không đụng file", (t) => {
  const { dir, base, head } = fixtureRepo(t, BUGGY, FIXED, TEST_ADD);
  writeFileSync(join(dir, "README.md"), "đang sửa dở\n");
  const r = runRegression(dir, base, head);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /chưa commit/);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "đang sửa dở\n");
  assert.equal(g(dir, "symbolic-ref", "--short", "HEAD"), "work");
  assert.equal(g(dir, "status", "--porcelain"), "M README.md");
});

test("--regression I/O: lỗi giữa chừng (không chạy được runner) → exit 2 và vẫn trả lại nhánh ban đầu", (t) => {
  const { dir, base, head } = fixtureRepo(t, BUGGY, FIXED, TEST_ADD);
  // PATH chỉ có git: spawn `node` của runner ENOENT → ném lỗi sau khi đã checkout head.
  const gitDir = process.env.PATH.split(delimiter).find((d) => d !== "" && existsSync(join(d, "git")));
  assert.ok(gitDir, "không tìm thấy git trong PATH");
  const bin = mkdtempSync(join(tmpdir(), "check-fix-pr-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  symlinkSync(join(gitDir, "git"), join(bin, "git"));
  const r = runRegression(dir, base, head, { PATH: bin });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /không chạy được node/);
  assertBackOnWork(dir);
});

// ───────────────── case đỏ không ở mức case: export mới chưa có trên base, hook cha lỗi (report thật, rút gọn) ─────────────────

// vitest 5.0.5 (`--reporter=json`): test gọi export mới → case chạy và fail với TypeError, file không lỗi nạp.
const VITEST_NEW_EXPORT = JSON.stringify({
  success: false,
  testResults: [
    {
      name: "/repo/packages/domain/src/zz.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["zz"],
          fullName: "zz newFn nhân đôi",
          status: "failed",
          title: "newFn nhân đôi",
          failureMessages: [
            "TypeError: (0 , __vite_ssr_import_0__.newFn) is not a function\n    at /repo/packages/domain/src/zz.test.ts:3:39\n" +
              "    at file:///repo/node_modules/.pnpm/vitest@5.0.5/node_modules/vitest/dist/chunks/run.BPv-BBRv.js:1632:35",
          ],
        },
        {
          ancestorTitles: ["zz"],
          fullName: "zz lớp mới",
          status: "failed",
          title: "lớp mới",
          failureMessages: [
            "TypeError: __vite_ssr_import_1__.default.Money is not a constructor\n    at /repo/x:1:1",
          ],
        },
        {
          ancestorTitles: ["hook"],
          fullName: "hook under failing beforeAll",
          status: "skipped",
          title: "under failing beforeAll",
          failureMessages: [],
        },
      ],
    },
  ],
});

// jest 29.7.0 + @swc/jest (`--json`): cùng ca; hook beforeAll lỗi → case failed, stack có `_callCircusHook`.
const JEST_NEW_EXPORT = JSON.stringify({
  success: false,
  testResults: [
    {
      name: "/repo/apps/backend/src/lib/__tests__/zz.unit.spec.ts",
      status: "failed",
      message:
        '  ● zz › newFn nhân đôi\n\n    TypeError: (0 , _src.newFn) is not a function\n\n      1 | import { newFn } from "./src";\n',
      assertionResults: [
        {
          ancestorTitles: ["zz"],
          fullName: "zz newFn nhân đôi",
          status: "failed",
          title: "newFn nhân đôi",
          failureMessages: [
            "TypeError: (0 , _src.newFn) is not a function\n    at Object.<anonymous> (/repo/apps/backend/src/lib/__tests__/zz.unit.spec.ts:3:44)\n" +
              "    at Promise.then.completed (/repo/node_modules/.pnpm/jest-circus@29.7.0/node_modules/jest-circus/build/utils.js:298:28)",
          ],
        },
        {
          ancestorTitles: ["zz"],
          fullName: "zz namespace",
          status: "failed",
          title: "namespace",
          failureMessages: [
            "TypeError: _money.round is not a function\n    at Object.<anonymous> (/repo/x:5:1)",
          ],
        },
        {
          ancestorTitles: ["hook"],
          fullName: "hook under failing beforeAll",
          status: "failed",
          title: "under failing beforeAll",
          failureMessages: [
            "Error: boom in beforeAll\n    at Object.<anonymous> (/repo/apps/backend/src/lib/__tests__/zz.unit.spec.ts:13:27)\n" +
              "    at Promise.then.completed (/repo/node_modules/.pnpm/jest-circus@29.7.0/node_modules/jest-circus/build/utils.js:298:28)\n" +
              "    at _callCircusHook (/repo/node_modules/.pnpm/jest-circus@29.7.0/node_modules/jest-circus/build/run.js:281:40)",
          ],
        },
        {
          ancestorTitles: ["thật"],
          fullName: "thật lỗi",
          status: "failed",
          title: "lỗi",
          failureMessages: [
            "TypeError: cart.items is not a function\n    at Object.<anonymous> (/repo/x:9:1)",
          ],
        },
      ],
    },
  ],
});

// node 22.22.0 junit: hook `before` lỗi → case `cancelledByParent`; `await import()` rồi gọi export mới → cause TypeError.
const JUNIT_HOOK_DYN = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="hook" time="0.0002" disabled="0" errors="0" tests="1" failures="1" skipped="0" hostname="vm">
		<testcase name="under failing before" time="0.000000" classname="test" failure="test did not finish before its parent and was cancelled">
			<failure type="cancelledByParent" message="test did not finish before its parent and was cancelled">
[Error [ERR_TEST_FAILURE]: test did not finish before its parent and was cancelled] { code: 'ERR_TEST_FAILURE', failureType: 'cancelledByParent', cause: 'test did not finish before its parent and was cancelled' }
			</failure>
		</testcase>
	</testsuite>
	<testcase name="dyn missing export" time="0.0006" classname="test" failure="m.newFn is not a function">
		<failure type="testCodeFailure" message="m.newFn is not a function">
[Error [ERR_TEST_FAILURE]: m.newFn is not a function] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: TypeError: m.newFn is not a function
      at TestContext.&lt;anonymous> (file:///repo/scripts/dyn.test.mjs:4:49)
}
		</failure>
	</testcase>
	<testcase name="lỗi thật" time="0.0006" classname="test" failure="x.y is not a function">
		<failure type="testCodeFailure" message="x.y is not a function">
[Error [ERR_TEST_FAILURE]: x.y is not a function] {
  cause: TypeError: x.y is not a function
}
		</failure>
	</testcase>
</testsuites>
`;

test("importBindings: namespace/default/await import/require + tên @swc/jest theo nguồn; không lấy named import", () => {
  const src = `import * as lib from "./lib.mjs";
import def, { a } from "../lib/money-round.js";
import type T from "./t";
import { b } from "@x-shop/domain/validation";
const m = await import("./src.mjs");
let r = require('2fa');
`;
  const b = importBindings(src);
  for (const n of ["lib", "def", "m", "r", "_lib", "_moneyround", "_validation", "_src", "_2fa"])
    assert.ok(b.has(n), n);
  for (const n of ["a", "b", "type", "T_"]) assert.ok(!b.has(n), n);
  assert.deepEqual([...importBindings("")], []);
  assert.deepEqual([...importBindings(undefined)], []);
  // Đầu vào bệnh lý lớn: tuyến tính (chống ReDoS).
  const t0 = Date.now();
  for (const x of [
    `import ${" ".repeat(100_000)}`,
    `import ${"a".repeat(100_000)}`,
    `const ${"a".repeat(50_000)} ${" ".repeat(50_000)}=`,
    `from "${"a".repeat(100_000)}`,
    `${"import * as ".repeat(20_000)}`,
    `${"require(".repeat(20_000)}`,
  ]) {
    importBindings(x);
    classifyFailure(`TypeError: ${"a".repeat(100_000)}`);
    classifyFailure(`TypeError: (0 , ${"a.".repeat(50_000)}`);
  }
  assert.ok(Date.now() - t0 < 2000, `quá chậm: ${Date.now() - t0} ms`);
});

test("classifyFailure: `(0 , X.Y)` biên dịch → nạp; `X.Y`/`X.default.Y` chỉ khi X là binding import; lỗi khác → null", () => {
  assert.equal(
    classifyFailure("TypeError: (0 , __vite_ssr_import_0__.newFn) is not a function\n at x"),
    "nạp",
  );
  assert.equal(classifyFailure("TypeError: (0 , _src.Money) is not a constructor"), "nạp");
  assert.equal(classifyFailure("TypeError: __vite_ssr_import_3__.default.f is not a function"), "nạp");
  assert.equal(classifyFailure("TypeError: m.newFn is not a function"), null);
  assert.equal(classifyFailure("TypeError: m.newFn is not a function", new Set(["m"])), "nạp");
  assert.equal(
    classifyFailure("TypeError: _money.default.K is not a constructor", new Set(["_money"])),
    "nạp",
  );
  for (const msg of [
    "AssertionError: expected 1 to be 2",
    "TypeError: cart.items is not a function",
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "Error: TypeError: (0 , _src.f) is not a function", // không ở đầu
    "",
    undefined,
  ]) {
    assert.equal(classifyFailure(msg, new Set(["_src"])), null, String(msg));
  }
});

test("parseJestLikeJson (vitest thật): case gọi export mới → broken/nạp; hook beforeAll lỗi đã là skipped", () => {
  const r = parseJestLikeJson(VITEST_NEW_EXPORT, TOP);
  assert.deepEqual(
    r.cases.map((c) => [c.name, c.status, c.why]),
    [
      ["zz > newFn nhân đôi", "broken", "nạp"],
      ["zz > lớp mới", "broken", "nạp"],
      ["hook > under failing beforeAll", "skipped", undefined],
    ],
  );
  assert.deepEqual(r.loadErrors, []);
});

test("parseJestLikeJson (jest thật): export mới → nạp; namespace swc khi biết binding; hook → broken/hook; lỗi thật giữ failed", () => {
  const file = "apps/backend/src/lib/__tests__/zz.unit.spec.ts";
  const bindings = new Map([[file, importBindings('import * as money from "../money";')]]);
  const r = parseReport("jest-json", JEST_NEW_EXPORT, { top: TOP, bindings });
  assert.deepEqual(
    r.cases.map((c) => [c.name, c.status, c.why]),
    [
      ["zz > newFn nhân đôi", "broken", "nạp"],
      ["zz > namespace", "broken", "nạp"],
      ["hook > under failing beforeAll", "broken", "hook"],
      ["thật > lỗi", "failed", undefined],
    ],
  );
  // Không có nguồn file test → chỉ dạng `(0 , X.Y)` nhận ra được.
  assert.equal(parseJestLikeJson(JEST_NEW_EXPORT, TOP).cases[1].status, "failed");
});

test("parseJunit (node thật): cancelledByParent → broken/hook; cause TypeError trên binding import → broken/nạp", () => {
  const b = importBindings('const m = await import("./src.mjs");');
  const r = parseReport("junit", JUNIT_HOOK_DYN, {
    file: "scripts/dyn.test.mjs",
    bindings: new Map([["scripts/dyn.test.mjs", b]]),
  });
  assert.deepEqual(
    r.cases.map((c) => [c.name, c.status, c.why]),
    [
      ["hook > under failing before", "broken", "hook"],
      ["dyn missing export", "broken", "nạp"],
      ["lỗi thật", "failed", undefined],
    ],
  );
  const hook = JUNIT_HOOK_DYN.replace('type="cancelledByParent"', 'type="hookFailure"');
  assert.equal(parseJunit(hook, "scripts/dyn.test.mjs").cases[0].why, "hook");
  assert.equal(parseJunit(JUNIT_HOOK_DYN, "scripts/dyn.test.mjs").cases[1].status, "failed");
  assert.throws(() => parseJunit('<testsuites><testcase name="a"><failure>x', "a"), /failure không đóng/);
});

test("regressionVerdict: case đỏ trên base chỉ vì export mới (report thật) → đỏ, không tính là tái hiện", () => {
  const plan = planRegression(["packages/domain/src/zz.test.ts"]);
  const base = [
    { runner: "vitest-domain", ok: false, note: "exit 1", ...parseJestLikeJson(VITEST_NEW_EXPORT, TOP) },
  ];
  const head = [
    {
      runner: "vitest-domain",
      ok: true,
      note: "exit 0",
      loadErrors: [],
      cases: base[0].cases.map((c) => ({ file: c.file, name: c.name, status: "passed" })),
    },
  ];
  assert.deepEqual(reproducedCases(head, base), []);
  const r = regressionVerdict({ plan, head, base });
  assert.equal(r.ok, false);
  assert.match(
    r.errors[0],
    /đỏ không ở mức case \(nạp\/hook\/quá hạn\).*2 case đỏ do export\/binding import chưa có/,
  );
});

test("parseJunit: `&` không có `;` gần → giữ nguyên; `;` xa hơn 11 ký tự không làm thành thực thể", () => {
  const far = `<testsuites><testcase name="a &amp ${"x".repeat(20)};b &lt;"/></testsuites>`;
  assert.equal(parseJunit(far, "a").cases[0].name, `a &amp ${"x".repeat(20)};b <`);
  const big = `<testsuites><testcase name="${"&x".repeat(200_000)};"/></testsuites>`;
  const t0 = Date.now();
  assert.equal(parseJunit(big, "a").cases[0].name.length, 400_001);
  assert.ok(Date.now() - t0 < 1000, `quá chậm: ${Date.now() - t0} ms`);
});
