import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractRefs, isTestFile, run, trace } from "./spec-trace.mjs";

const crit = (id, aliases = [], spec = "SPEC-a.md") => ({ id, aliases, spec, title: "" });
const refs = (...r) => new Set(r);

test("extractRefs: S-NNN và ATNN/AT-NN theo từ nguyên, không bắt chuỗi dính", () => {
  const r = extractRefs("it('S-108 ok AT09, AT-31') // PS-001 S-0012 AT123 xAT05 S-201.");
  assert.deepEqual([...r].sort(), ["AT09", "AT31", "S-108", "S-201"]);
});

test("isTestFile", () => {
  assert.equal(isTestFile("apps/x/src/a.test.tsx"), true);
  assert.equal(isTestFile("apps/backend/src/lib/__tests__/helper.ts"), true);
  assert.equal(isTestFile("apps/backend/integration-tests/http/a.spec.ts"), true);
  assert.equal(isTestFile("apps/backend/src/lib/a.ts"), false);
  assert.equal(isTestFile("docs/a.test.md"), false);
});

test("trace: có test (qua ID hoặc bí danh), thiếu, allowlist", () => {
  const criteria = [crit("S-001"), crit("S-002", ["AT02"]), crit("S-003"), crit("S-004")];
  const testRefs = new Map([
    ["a.test.ts", refs("S-001")],
    ["b.test.ts", refs("AT02")],
  ]);
  const r = trace(criteria, testRefs, [{ id: "S-004", reason: "chưa có test tự động — kiểm tay" }]);
  assert.deepEqual(
    r.covered.map((c) => c.id),
    ["S-001", "S-002"],
  );
  assert.deepEqual(
    r.allowed.map((c) => c.id),
    ["S-004"],
  );
  assert.deepEqual(
    r.missing.map((c) => c.id),
    ["S-003"],
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /S-003.*không test nào nhắc/);
});

test("trace: allowlist sai — ID đã có test, ID không còn, thiếu lý do, trùng", () => {
  const r = trace([crit("S-001")], new Map([["a.test.ts", refs("S-001")]]), [
    { id: "S-001", reason: "lý do đủ dài ở đây" },
    { id: "S-777", reason: "lý do đủ dài ở đây" },
    { id: "S-001", reason: "" },
  ]);
  const e = r.errors.join("\n");
  assert.match(e, /S-001 đã có test/);
  assert.match(e, /S-777 không còn trong spec/);
  assert.match(e, /S-001 thiếu lý do/);
});

test("trace: rỗng — không tiêu chí → không lỗi; ID trùng giữa spec → lỗi", () => {
  assert.deepEqual(trace([], new Map(), []).errors, []);
  const r = trace(
    [crit("S-001", [], "SPEC-a.md"), crit("S-001", [], "SPEC-b.md")],
    new Map([["t.test.ts", refs("S-001")]]),
    [],
  );
  assert.match(r.errors.join("\n"), /trùng giữa các spec/);
});

function fixture({ test: testSrc, allow }) {
  const base = mkdtempSync(join(tmpdir(), "trace-"));
  mkdirSync(join(base, "docs/specs"), { recursive: true });
  mkdirSync(join(base, "apps/x/__tests__"), { recursive: true });
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(
    join(base, "docs/specs/SPEC-a.md"),
    "| Trạng thái | Approved |\n## 2. Tiêu chí chấp nhận\n### S-001 A (AT01)\n- Then 403.\n### S-002 B\n- Then 422.\n",
  );
  writeFileSync(join(base, "apps/x/__tests__/a.unit.spec.ts"), testSrc);
  if (allow) writeFileSync(join(base, "scripts/spec-trace-allowlist.json"), allow);
  return base;
}

test("run (thư mục tạm): thiếu test → 1; thêm allowlist → 0; AT bí danh tính là có test", () => {
  const base = fixture({ test: "it('AT01 ok')" });
  const r1 = run(base);
  assert.equal(r1.code, 1);
  assert.match(r1.errors[0], /S-002/);
  writeFileSync(
    join(base, "scripts/spec-trace-allowlist.json"),
    JSON.stringify([{ id: "S-002", reason: "chưa có test tự động — kiểm tay" }]),
  );
  const r2 = run(base);
  assert.equal(r2.code, 0);
  assert.equal(r2.covered.length, 1);
  assert.equal(r2.allowed.length, 1);
});

test("run: allowlist hỏng JSON / sai kiểu → 2; không có spec → 1/2", () => {
  assert.equal(run(fixture({ test: "", allow: "{không phải json" })).code, 2);
  assert.equal(run(fixture({ test: "", allow: "{}" })).code, 2);
  assert.equal(run(mkdtempSync(join(tmpdir(), "empty-"))).code, 2);
});

test("run: file test trong node_modules không tính", () => {
  const base = fixture({ test: "" });
  mkdirSync(join(base, "apps/x/node_modules/p/__tests__"), { recursive: true });
  writeFileSync(join(base, "apps/x/node_modules/p/__tests__/z.spec.ts"), "S-001 S-002");
  assert.equal(run(base).code, 1);
});
