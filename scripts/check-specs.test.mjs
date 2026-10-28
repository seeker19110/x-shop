import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkPrSpec,
  checkSpec,
  criteriaSection,
  isIsoDate,
  parseCriteria,
  parseMeta,
  run,
} from "./check-specs.mjs";

const NOW = new Date("2026-10-28T00:00:00Z");

const spec = ({ status = "Approved (D-1)", by = "Phiên chính", at = "2026-10-24", criteria } = {}) =>
  [
    "# SPEC-x",
    "",
    "| Trường | Giá trị |",
    "|---|---|",
    status === null ? "" : `| Trạng thái | ${status} |`,
    by === null ? "" : `| approved_by | ${by} |`,
    at === null ? "" : `| approved_at | ${at} |`,
    "",
    "## 2. Tiêu chí chấp nhận",
    criteria ?? "### S-001 Đặt hàng (AT01)\n- Then 409 `PRICE_CHANGED`.\n",
    "## 3. Ca biên",
    "### S-999 ngoài mục tiêu chí",
  ].join("\n");

test("spec hợp lệ → không lỗi", () => {
  assert.deepEqual(checkSpec("SPEC-x.md", spec(), NOW), []);
});

test("thiếu trạng thái → lỗi", () => {
  const e = checkSpec("SPEC-x.md", spec({ status: null }), NOW);
  assert.match(e.join("\n"), /thiếu trạng thái/);
});

test("Approved thiếu approved_by / approved_at → lỗi riêng từng trường", () => {
  const e = checkSpec("SPEC-x.md", spec({ by: null, at: null }), NOW).join("\n");
  assert.match(e, /thiếu approved_by/);
  assert.match(e, /thiếu approved_at/);
});

test("approved_by rỗng (ô trống) tính là thiếu", () => {
  assert.match(checkSpec("SPEC-x.md", spec({ by: "" }), NOW).join("\n"), /thiếu approved_by/);
});

test("approved_at sai định dạng, ngày không có thật, tương lai → lỗi", () => {
  assert.match(checkSpec("a", spec({ at: "24/10/2026" }), NOW).join("\n"), /không phải ngày ISO/);
  assert.match(checkSpec("a", spec({ at: "2026-02-31" }), NOW).join("\n"), /không phải ngày ISO/);
  assert.match(checkSpec("a", spec({ at: "2027-01-01" }), NOW).join("\n"), /tương lai/);
});

test("Draft không cần approved_*", () => {
  assert.deepEqual(checkSpec("a", spec({ status: "Draft", by: null, at: null }), NOW), []);
});

test("frontmatter status/approved_* cũng được nhận", () => {
  const text =
    "---\nstatus: approved\napproved_by: Người A\napproved_at: 2026-10-01\n---\n## Tiêu chí chấp nhận\n### S-001 x\n- Then 403.\n";
  assert.deepEqual(checkSpec("a", text, NOW), []);
  assert.equal(parseMeta(text).status, "approved");
});

test("thiếu mục tiêu chí / không có ID / thiếu ca lỗi / trùng ID → lỗi", () => {
  assert.match(checkSpec("a", "| Trạng thái | Draft |\n", NOW).join("\n"), /thiếu mục "Tiêu chí chấp nhận"/);
  assert.match(checkSpec("a", spec({ criteria: "chỉ văn xuôi" }), NOW).join("\n"), /không có ID/);
  assert.match(
    checkSpec("a", spec({ criteria: "### S-001 a\n- Then ok.\n" }), NOW).join("\n"),
    /không có ca lỗi/,
  );
  assert.match(
    checkSpec("a", spec({ criteria: "### S-001 a\n- Then 422.\n### S-001 b\n" }), NOW).join("\n"),
    /trùng ID tiêu chí S-001/,
  );
});

test("criteriaSection dừng ở heading cùng cấp; parseCriteria lấy bí danh AT (cả AT-NN) và ID có Unicode quanh", () => {
  const s = criteriaSection(spec());
  assert.ok(s.includes("S-001") && !s.includes("S-999"));
  const c = parseCriteria("### S-101 Giá đổi (AT-03, AT07)\n### S-102 Không bí danh\n");
  assert.deepEqual(
    c.map((x) => [x.id, x.aliases]),
    [
      ["S-101", ["AT03", "AT07"]],
      ["S-102", []],
    ],
  );
});

test("isIsoDate", () => {
  assert.equal(isIsoDate("2026-10-24"), true);
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate(undefined), false);
  assert.equal(isIsoDate(""), false);
});

test("run: thư mục thật tạm — pass, rồi fail khi thêm spec hỏng; thư mục vắng → 2; không có spec → 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "specs-"));
  assert.equal(run(dir, NOW).code, 1);
  writeFileSync(join(dir, "SPEC-ok.md"), spec());
  assert.equal(run(dir, NOW).code, 0);
  writeFileSync(join(dir, "SPEC-bad.md"), spec({ at: null }));
  const r = run(dir, NOW);
  assert.equal(r.code, 1);
  assert.match(r.errors[0], /SPEC-bad\.md/);
  assert.equal(run(join(dir, "khong-co"), NOW).code, 2);
});

function prDir() {
  const dir = mkdtempSync(join(tmpdir(), "prspec-"));
  writeFileSync(join(dir, "SPEC-ok.md"), spec());
  writeFileSync(join(dir, "SPEC-draft.md"), spec({ status: "Draft" }));
  return dir;
}
const MAP = "\n## Map tiêu chí → test\n- S-001 → `checkout.spec.ts › giá đổi`\n\n## Rủi ro\nx";

test("PR không phải feat → bỏ qua kiểm spec", () => {
  assert.deepEqual(checkPrSpec({ title: "fix(a): b", commits: ["docs: c"], body: "" }, prDir()), []);
});

test("PR feat (theo tiêu đề hoặc theo commit) link spec Approved + có map → đạt", () => {
  const body = "Spec: docs/specs/SPEC-ok.md" + MAP;
  assert.deepEqual(checkPrSpec({ title: "feat(cart): x", body }, prDir()), []);
  assert.deepEqual(checkPrSpec({ title: "chore: x", commits: ["feat!: y"], body }, prDir()), []);
});

test("PR feat không link spec / spec Draft / spec không tồn tại → lỗi", () => {
  const d = prDir();
  assert.match(
    checkPrSpec({ title: "feat: x", body: "không link" + MAP }, d).join("\n"),
    /phải link một SPEC/,
  );
  assert.match(
    checkPrSpec({ title: "feat: x", body: "SPEC-draft.md" + MAP }, d).join("\n"),
    /không có spec Approved/,
  );
  assert.match(
    checkPrSpec({ title: "feat: x", body: "SPEC-khong-co" + MAP }, d).join("\n"),
    /không có spec Approved/,
  );
});

test("PR feat: link nằm trong chú thích mẫu không tính; map trống/thiếu → lỗi", () => {
  const d = prDir();
  assert.match(
    checkPrSpec({ title: "feat: x", body: "<!-- SPEC-ok -->" + MAP }, d).join("\n"),
    /phải link một SPEC/,
  );
  assert.match(checkPrSpec({ title: "feat: x", body: "SPEC-ok" }, d).join("\n"), /thiếu mục "## Map/);
  assert.match(
    checkPrSpec({ title: "feat: x", body: "SPEC-ok\n## Map tiêu chí → test\n<!-- ghi ở đây -->\n" }, d).join(
      "\n",
    ),
    /thiếu mục "## Map/,
  );
  assert.deepEqual(
    checkPrSpec({ title: "feat: x", body: "SPEC-ok\n## Map tiêu chí → test\nS-001 → test a" }, d),
    [],
  );
});
