// Fixture dùng ID giả lập (S-9xx, AT9x) — KHÔNG dùng ID thật của docs/specs, để test của bộ kiểm không phủ giả
// (spec-trace.test.mjs có test chặn việc này).
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
    criteria ?? "### S-901 Đặt hàng (AT91)\n- Then 409 `PRICE_CHANGED`.\n",
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

test("nhận diện Approved: neo đầu chuỗi, theo từ, không phân biệt hoa/thường", () => {
  const noMeta = { by: null, at: null };
  // Không phải Approved → không đòi approved_*.
  assert.deepEqual(checkSpec("a", spec({ status: "Not approved yet", ...noMeta }), NOW), []);
  assert.deepEqual(checkSpec("a", spec({ status: "Approvedx", ...noMeta }), NOW), []);
  // Là Approved (kể cả viết thường / kèm ghi chú) → đòi approved_*.
  assert.match(checkSpec("a", spec({ status: "approved", ...noMeta }), NOW).join("\n"), /thiếu approved_by/);
  assert.match(
    checkSpec("a", spec({ status: "Approved for implementation (D-1)", ...noMeta }), NOW).join("\n"),
    /thiếu approved_by/,
  );
});

test("frontmatter status/approved_* cũng được nhận", () => {
  const text =
    "---\nstatus: approved\napproved_by: Người A\napproved_at: 2026-10-01\n---\n## Tiêu chí chấp nhận\n### S-901 x\n- Then 403.\n";
  assert.deepEqual(checkSpec("a", text, NOW), []);
  assert.equal(parseMeta(text).status, "approved");
});

test("parseMeta: giá trị đầu tiên thắng (bảng lặp dòng; frontmatter thắng bảng)", () => {
  assert.equal(parseMeta("| Trạng thái | Draft |\n| Trạng thái | Approved |\n").status, "Draft");
  assert.equal(parseMeta("| approved_by | A |\n| approved_by | B |\n").approved_by, "A");
  assert.equal(parseMeta("---\nstatus: Draft\n---\n| Trạng thái | Approved |\n").status, "Draft");
});

test("thiếu mục tiêu chí / không có ID / thiếu ca lỗi / trùng ID → lỗi", () => {
  assert.match(checkSpec("a", "| Trạng thái | Draft |\n", NOW).join("\n"), /thiếu mục "Tiêu chí chấp nhận"/);
  assert.match(checkSpec("a", spec({ criteria: "chỉ văn xuôi" }), NOW).join("\n"), /không có ID/);
  assert.match(
    checkSpec("a", spec({ criteria: "### S-901 a\n- Then ok.\n" }), NOW).join("\n"),
    /không có ca lỗi/,
  );
  assert.match(
    checkSpec("a", spec({ criteria: "### S-901 a\n- Then 422.\n### S-901 b\n" }), NOW).join("\n"),
    /trùng ID tiêu chí S-901/,
  );
});

test("ID tiêu chí sai độ dài (S-1001, S-12) không bị bỏ qua im lặng", () => {
  const e = checkSpec("a", spec({ criteria: "### S-901 a\n- Then 422.\n### S-1001 b\n### S-12 c\n" }), NOW);
  const msg = e.join("\n");
  assert.match(msg, /S-1001 phải đúng dạng S-NNN/);
  assert.equal(parseCriteria("### S-1001 b\n").length, 1);
  // S-12 (2 chữ số) cũng là ID bất thường được đếm rồi báo lỗi.
  assert.match(msg, /S-12 phải đúng dạng/);
});

test("criteriaSection dừng ở heading cùng cấp; parseCriteria lấy bí danh AT (cả AT-NN) và chuẩn hoá 2 chữ số", () => {
  const s = criteriaSection(spec());
  assert.ok(s.includes("S-901") && !s.includes("S-999"));
  const c = parseCriteria(
    `### S-911 Giá đổi (AT-93, AT97)\n### S-912 Không bí danh\n### S-913 (A${"T"}-${String(3)})\n`,
  );
  assert.deepEqual(
    c.map((x) => [x.id, x.aliases]),
    [
      ["S-911", ["AT93", "AT97"]],
      ["S-912", []],
      ["S-913", [`A${"T"}0${String(3)}`]],
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
const MAP = "\n## Map tiêu chí → test\n- S-901 → `ví-dụ.spec.ts › giá đổi`\n\n## Rủi ro\nx";

test("PR không phải feat → bỏ qua kiểm spec", () => {
  assert.deepEqual(checkPrSpec({ title: "fix(a): b", commits: ["docs: c"], body: "" }, prDir()), []);
});

test("PR feat (theo tiêu đề hoặc theo commit) link spec Approved + có map → đạt", () => {
  const body = "Spec: docs/specs/SPEC-ok.md" + MAP;
  assert.deepEqual(checkPrSpec({ title: "feat(cart): x", body }, prDir()), []);
  assert.deepEqual(checkPrSpec({ title: "chore: x", commits: ["feat!: y"], body }, prDir()), []);
});

test("PR có commit feat nhưng tiêu đề không feat, thiếu spec → lỗi (commit cũng được xét)", () => {
  const e = checkPrSpec(
    { title: "chore: x", commits: ["docs: a", "feat(cart): y"], body: "không link" + MAP },
    prDir(),
  );
  assert.match(e.join("\n"), /phải link một SPEC/);
});

test("commit/tiêu đề `Feat:` viết hoa coi như feat; khoảng trắng đầu dòng bỏ qua", () => {
  assert.match(checkPrSpec({ title: "Feat: x", body: "" }, prDir()).join("\n"), /phải link một SPEC/);
  assert.match(
    checkPrSpec({ title: "chore: x", commits: ["  FEAT(a): y"], body: "" }, prDir()).join("\n"),
    /phải link một SPEC/,
  );
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
    checkPrSpec({ title: "feat: x", body: "SPEC-ok\n## Map tiêu chí → test\nS-901 → test a" }, d),
    [],
  );
});

test("PR feat: bảng map chỉ có dòng ngăn cách không tính là nội dung; có dòng dữ liệu thì tính", () => {
  const d = prDir();
  const onlySeparator = "SPEC-ok\n## Map tiêu chí → test\n|---|:---:|\n";
  assert.match(checkPrSpec({ title: "feat: x", body: onlySeparator }, d).join("\n"), /thiếu mục "## Map/);
  const sepOnly = "SPEC-ok\n## Map tiêu chí → test\n|---|---|\n| --- | --- |\n";
  assert.match(checkPrSpec({ title: "feat: x", body: sepOnly }, d).join("\n"), /thiếu mục "## Map/);
  const withRow = onlySeparator + "| S-901 | a.spec.ts |\n";
  assert.deepEqual(checkPrSpec({ title: "feat: x", body: withRow }, d), []);
});
