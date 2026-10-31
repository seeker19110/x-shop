import assert from "node:assert/strict";
import { test } from "node:test";
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
  parseRegressionArgs,
  planRegression,
  regressionVerdict,
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
  assert.deepEqual(classifyTest("apps/backend/src/modules/settlement/__tests__/svc.spec.ts"), {
    skip: SKIP_INTEGRATION,
  });
  assert.deepEqual(classifyTest("e2e/checkout-cod.spec.ts"), { skip: SKIP_E2E });
  for (const f of [
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
const res = (...oks) => oks.map((ok, i) => ({ runner: PLAN2.groups[i].runner, ok }));

test("regressionVerdict: HEAD xanh + base có ít nhất một lệnh đỏ → đạt", () => {
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
