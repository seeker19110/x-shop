import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommits, isExempt, lintMessage, parseLog } from "./check-commits.mjs";

test("lintMessage: subject hợp lệ (type, scope, !, Unicode) đạt", () => {
  for (const m of [
    "feat: thêm giỏ hàng",
    "fix(cart): sửa lỗi làm tròn",
    "refactor(a-b.c/d)!: đổi API",
    "ci: ghim digest image (T-106)\n",
    "docs: x\n\nThân nhiều dòng.\nDòng hai.",
  ]) {
    assert.deepEqual(lintMessage(m), [], m);
  }
});

test("lintMessage: rỗng/null/chỉ khoảng trắng, sai type, thiếu mô tả, hoa/thường, thiếu khoảng trắng sau dấu hai chấm", () => {
  for (const m of ["", null, undefined, "   \n"]) assert.deepEqual(lintMessage(m), ["thông điệp rỗng"]);
  for (const m of [
    "feature: a",
    "Fix: a",
    "fix:a",
    "fix: ",
    "fix(): a",
    "fix(Cart): a",
    "cập nhật gì đó",
    "fixup! fix: a",
  ]) {
    assert.match(lintMessage(m).join("|"), /subject phải dạng/, m);
  }
});

test("lintMessage: ranh giới 72 ký tự tính theo ký tự Unicode, không theo byte", () => {
  const head = "fix: ";
  const ok = head + "ế".repeat(72 - head.length); // 72 ký tự, > 72 byte
  const long = head + "ế".repeat(73 - head.length);
  assert.deepEqual(lintMessage(ok), []);
  assert.match(lintMessage(long).join("|"), /73 ký tự/);
});

test("lintMessage: thân phải cách subject một dòng trống; CRLF được chấp nhận", () => {
  assert.match(lintMessage("fix: a\nthân dính liền").join("|"), /dòng trống/);
  assert.deepEqual(lintMessage("fix: a\r\n\r\nthân\r\n"), []);
});

test("lintMessage: footer BREAKING CHANGE đúng/ sai (thường, rỗng, BREAKING-CHANGE hợp lệ); `!` đứng một mình đạt", () => {
  assert.deepEqual(lintMessage("feat: a\n\nBREAKING CHANGE: bỏ trường cũ"), []);
  assert.deepEqual(lintMessage("feat: a\n\nBREAKING-CHANGE: bỏ trường cũ"), []);
  assert.deepEqual(lintMessage("feat!: a"), []);
  assert.match(lintMessage("feat: a\n\nbreaking change: bỏ").join("|"), /BREAKING CHANGE/);
  assert.match(lintMessage("feat: a\n\nBREAKING CHANGE:").join("|"), /BREAKING CHANGE/);
  assert.match(lintMessage("feat: a\n\nBREAKING CHANGE:   ").join("|"), /BREAKING CHANGE/);
});

test("isExempt: merge, Revert của GitHub, bot được miễn; commit thường và Revert tự viết sai thì không", () => {
  assert.equal(isExempt({ subject: "Merge branch 'a' into b" }), true);
  assert.equal(isExempt({ subject: 'Revert "feat: a"' }), true);
  assert.equal(isExempt({ subject: "x", author: "49699333+dependabot[bot]@users.noreply.github.com" }), true);
  assert.equal(isExempt({ subject: "fix: a", author: "a@b.c" }), false);
  assert.equal(isExempt({ subject: "Revert something" }), false);
  assert.equal(isExempt(), false);
});

test("parseLog + checkCommits: tách bản ghi, bỏ commit miễn, chỉ trả commit vi phạm; log rỗng → []", () => {
  const raw =
    "aaa111\x1fa@b.c\x1ffeat: ok\n\x1e\n" +
    "bbb222\x1fa@b.c\x1fbậy bạ\n\ncó thân\n\x1e\n" +
    "ccc333\x1fx@users.noreply.github.com\x1fMerge pull request #1\n\x1e\n" +
    "ddd444\x1fbot[bot]@users.noreply.github.com\x1fbump deps\n\x1e\n";
  const commits = parseLog(raw);
  assert.equal(commits.length, 4);
  assert.equal(commits[1].subject, "bậy bạ");
  const bad = checkCommits(commits);
  assert.deepEqual(
    bad.map((b) => b.sha),
    ["bbb222"],
  );
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(parseLog(null), []);
  assert.deepEqual(checkCommits([]), []);
});
