import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExceptions, classify, findings } from "./osv-gate.mjs";

const NOW = new Date("2026-10-26T00:00:00Z");
const report = (groups) => ({
  results: [{ packages: [{ package: { name: "lodash", version: "4.17.23" }, groups }] }],
});

test("findings/classify: >= 7.0 chặn (kể cả đúng 7.0), 6.9 cảnh báo, không có điểm coi như chặn; rỗng/null → không có", () => {
  const f = findings(
    report([
      { ids: ["GHSA-a"], aliases: ["CVE-1", "GHSA-a"], max_severity: "7.0" },
      { ids: ["GHSA-b"], aliases: [], max_severity: "6.9" },
      { ids: ["GHSA-c"], aliases: [], max_severity: "" },
    ]),
  );
  assert.equal(f[0].cve, "CVE-1");
  const c = classify(f);
  assert.deepEqual(
    c.blocking.map((x) => x.id),
    ["GHSA-a", "GHSA-c"],
  );
  assert.deepEqual(
    c.warnings.map((x) => x.id),
    ["GHSA-b"],
  );
  assert.deepEqual(findings({}), []);
  assert.deepEqual(findings(null), []);
  assert.deepEqual(classify([]), { blocking: [], warnings: [] });
});

const ok = `[[IgnoredVulns]]
id = "GHSA-a"
# approved_by: chủ dự án
ignoreUntil = "2026-12-31"
reason = "Không gọi hàm bị ảnh hưởng; chờ bản vá của upstream"
`;

test("checkExceptions: hợp lệ → rỗng; không có file/rỗng/null → rỗng", () => {
  assert.deepEqual(checkExceptions(ok, NOW), []);
  assert.deepEqual(checkExceptions("", NOW), []);
  assert.deepEqual(checkExceptions(null, NOW), []);
  assert.deepEqual(checkExceptions("# chỉ có chú thích\n", NOW), []);
});

test("checkExceptions: quá hạn, thiếu trường, sai định dạng ngày, vượt 90 ngày, thiếu approved_by đều đỏ", () => {
  assert.match(checkExceptions(ok.replace("2026-12-31", "2026-10-25"), NOW).join("|"), /quá hạn/);
  assert.match(checkExceptions(ok.replace("2026-12-31", "2027-06-01"), NOW).join("|"), /vượt 90 ngày/);
  assert.match(checkExceptions(ok.replace("2026-12-31", "31/12/2026"), NOW).join("|"), /ignoreUntil/);
  assert.match(checkExceptions(ok.replace(/reason = .*\n/, ""), NOW).join("|"), /thiếu reason/);
  assert.match(checkExceptions(ok.replace("# approved_by: chủ dự án\n", ""), NOW).join("|"), /approved_by/);
  assert.match(checkExceptions(ok.replace('id = "GHSA-a"\n', ""), NOW).join("|"), /thiếu id/);
});

test("checkExceptions: hết hạn đúng cuối ngày hôm nay vẫn còn hiệu lực; nhiều khối báo đúng số thứ tự", () => {
  assert.deepEqual(checkExceptions(ok.replace("2026-12-31", "2026-10-26"), NOW), []);
  const two = `${ok}\n[[IgnoredVulns]]\nid = "GHSA-z"\n`;
  const errs = checkExceptions(two, NOW);
  assert.ok(
    errs.every((e) => e.startsWith("IgnoredVulns #2")),
    errs.join("|"),
  );
  assert.equal(errs.length, 3);
});
