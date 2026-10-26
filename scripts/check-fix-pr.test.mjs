import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFixPr, fieldOf, isFixTitle, isTestFile } from "./check-fix-pr.mjs";

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
