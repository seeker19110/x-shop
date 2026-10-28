// Fixture dùng ID giả lập (S-9xx, AT9x) — KHÔNG dùng ID thật của docs/specs; hai file test của bộ kiểm cũng bị loại khỏi
// tập file test được quét (SELF_TESTS), và test cuối chặn việc dùng ID thật.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractRefs, isTestFile, loadCriteria, run, trace } from "./spec-trace.mjs";

const crit = (id, aliases = [], spec = "SPEC-a.md") => ({ id, aliases, spec, title: "" });
const refs = (...r) => new Set(r);

test("extractRefs: S-NNN và ATNN/AT-NN theo từ nguyên, không bắt chuỗi dính", () => {
  const r = extractRefs("it('S-908 ok AT99, AT-91') // PS-901 S-0912 AT923 xAT95 S-901.");
  assert.deepEqual([...r].sort(), ["AT91", "AT99", "S-901", "S-908"]);
});

test("extractRefs: AT một chữ số chuẩn hoá về hai chữ số", () => {
  // Ghép chuỗi lúc chạy để mã nguồn test không chứa literal ID thật (test cuối quét literal).
  const n = String(3);
  assert.deepEqual([...extractRefs(`A${"T"}${n} A${"T"}-${n}`)], [`A${"T"}0${n}`]);
});

test("isTestFile: chỉ *.test.*/*.spec.*; script diễn tập và test của chính bộ kiểm không tính", () => {
  assert.equal(isTestFile("apps/x/src/a.test.tsx"), true);
  assert.equal(isTestFile("apps/backend/src/lib/__tests__/a.unit.spec.ts"), true);
  assert.equal(isTestFile("apps/backend/integration-tests/http/a.spec.ts"), true);
  assert.equal(isTestFile("apps/backend/src/lib/__tests__/helper.ts"), false);
  assert.equal(isTestFile("apps/backend/integration-tests/ops/redis-loss-drill.ts"), false);
  assert.equal(isTestFile("apps/backend/src/lib/a.ts"), false);
  assert.equal(isTestFile("docs/a.test.md"), false);
  assert.equal(isTestFile("scripts/spec-trace.test.mjs"), false);
  assert.equal(isTestFile("scripts/check-specs.test.mjs"), false);
  assert.equal(isTestFile("scripts/check-units.test.mjs"), true);
});

test("trace: có test (qua ID hoặc bí danh), thiếu, allowlist", () => {
  const criteria = [crit("S-901"), crit("S-902", ["AT92"]), crit("S-903"), crit("S-904")];
  const testRefs = new Map([
    ["a.test.ts", refs("S-901")],
    ["b.test.ts", refs("AT92")],
  ]);
  const r = trace(criteria, testRefs, [{ id: "S-904", reason: "chưa có test tự động — kiểm tay" }]);
  assert.deepEqual(
    r.covered.map((c) => c.id),
    ["S-901", "S-902"],
  );
  assert.deepEqual(
    r.allowed.map((c) => c.id),
    ["S-904"],
  );
  assert.deepEqual(
    r.missing.map((c) => c.id),
    ["S-903"],
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /S-903.*không test nào nhắc/);
});

test("trace: allowlist sai — ID đã có test, ID không còn, thiếu lý do", () => {
  const r = trace([crit("S-901")], new Map([["a.test.ts", refs("S-901")]]), [
    { id: "S-901", reason: "lý do đủ dài ở đây" },
    { id: "S-977", reason: "lý do đủ dài ở đây" },
  ]);
  const e = r.errors.join("\n");
  assert.match(e, /S-901 đã có test/);
  assert.match(e, /S-977 không còn trong spec/);
  assert.match(
    trace([crit("S-901")], new Map(), [{ id: "S-901", reason: "" }]).errors.join("\n"),
    /thiếu lý do/,
  );
  assert.match(
    trace([crit("S-901")], new Map(), [{ reason: "lý do đủ dài ở đây" }]).errors.join("\n"),
    /thiếu "id"/,
  );
});

test("trace: lý do allowlist đúng ngưỡng 10 ký tự (9 → lỗi, 10 → đạt)", () => {
  const at = (reason) => trace([crit("S-901")], new Map(), [{ id: "S-901", reason }]);
  assert.match(at("123456789").errors.join("\n"), /thiếu lý do/);
  assert.match(at("   12345   ").errors.join("\n"), /thiếu lý do/); // khoảng trắng không tính
  assert.deepEqual(at("1234567890").errors, []);
});

test("trace: ID trùng trong allowlist (cả hai có lý do hợp lệ) → lỗi trùng", () => {
  const r = trace([crit("S-901")], new Map(), [
    { id: "S-901", reason: "lý do thứ nhất đủ dài" },
    { id: "S-901", reason: "lý do thứ hai đủ dài" },
  ]);
  assert.match(r.errors.join("\n"), /allowlist: trùng S-901/);
  assert.equal(r.allowed.length, 1);
});

test("trace: rỗng — không tiêu chí → không lỗi; ID trùng giữa spec → lỗi", () => {
  assert.deepEqual(trace([], new Map(), []).errors, []);
  const r = trace(
    [crit("S-901", [], "SPEC-a.md"), crit("S-901", [], "SPEC-b.md")],
    new Map([["t.test.ts", refs("S-901")]]),
    [],
  );
  assert.match(r.errors.join("\n"), /trùng giữa các spec/);
});

test("trace: bí danh AT dùng chung hai tiêu chí → cảnh báo (không lỗi); bí danh riêng → không cảnh báo", () => {
  const r = trace(
    [crit("S-901", ["AT91"]), crit("S-902", ["AT91", "AT92"]), crit("S-903", ["AT93"])],
    new Map([["t.test.ts", refs("AT91", "AT92", "AT93")]]),
    [],
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /AT91.*S-901, S-902/);
  assert.deepEqual(trace([crit("S-901", ["AT91"])], new Map(), []).warnings, []);
});

function fixture({ test: testSrc, allow }) {
  const base = mkdtempSync(join(tmpdir(), "trace-"));
  mkdirSync(join(base, "docs/specs"), { recursive: true });
  mkdirSync(join(base, "apps/x/__tests__"), { recursive: true });
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(
    join(base, "docs/specs/SPEC-a.md"),
    "| Trạng thái | Approved |\n## 2. Tiêu chí chấp nhận\n### S-901 A (AT91)\n- Then 403.\n### S-902 B\n- Then 422.\n",
  );
  writeFileSync(join(base, "apps/x/__tests__/a.unit.spec.ts"), testSrc);
  if (allow) writeFileSync(join(base, "scripts/spec-trace-allowlist.json"), allow);
  return base;
}

test("run (thư mục tạm): thiếu test → 1; thêm allowlist → 0; AT bí danh tính là có test", () => {
  const base = fixture({ test: "it('AT91 ok')" });
  const r1 = run(base);
  assert.equal(r1.code, 1);
  assert.match(r1.errors[0], /S-902/);
  writeFileSync(
    join(base, "scripts/spec-trace-allowlist.json"),
    JSON.stringify([{ id: "S-902", reason: "chưa có test tự động — kiểm tay" }]),
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

test("run: file test trong node_modules, script diễn tập (không *.spec/*.test) không tính", () => {
  const base = fixture({ test: "" });
  mkdirSync(join(base, "apps/x/node_modules/p/__tests__"), { recursive: true });
  writeFileSync(join(base, "apps/x/node_modules/p/__tests__/z.spec.ts"), "S-901 S-902");
  mkdirSync(join(base, "apps/x/integration-tests/ops"), { recursive: true });
  writeFileSync(join(base, "apps/x/integration-tests/ops/drill.ts"), "S-901 S-902");
  assert.equal(run(base).code, 1);
});

test("run: hai file test của chính bộ kiểm trong scripts/ không tính là phủ", () => {
  const base = fixture({ test: "" });
  writeFileSync(join(base, "scripts/spec-trace.test.mjs"), "S-901 S-902");
  writeFileSync(join(base, "scripts/check-specs.test.mjs"), "AT91 S-902");
  assert.equal(run(base).code, 1);
  writeFileSync(join(base, "scripts/other.test.mjs"), "S-901 S-902");
  assert.equal(run(base).code, 0);
});

test("fixture của hai test bộ kiểm không dùng ID/bí danh thật của docs/specs", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const real = new Set();
  for (const c of loadCriteria()) {
    real.add(c.id);
    for (const a of c.aliases) real.add(a);
  }
  assert.ok(real.size > 20, "phải đọc được tiêu chí thật");
  for (const f of ["spec-trace.test.mjs", "check-specs.test.mjs"]) {
    const used = [...extractRefs(readFileSync(join(here, f), "utf8"))].filter((r) => real.has(r));
    assert.deepEqual(used, [], `${f} dùng ID thật làm fixture: ${used.join(", ")}`);
  }
});
