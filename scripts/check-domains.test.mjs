import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, compareSet, CORE_FILES, parseDomains, TECH_DIRS } from "./check-domains.mjs";

const DOC = `# Miền

| Miền | Spec | Module backend | Lõi thuần | Bất biến |
| ---- | ---- | -------------- | --------- | -------- |
| A | S | \`alpha\`, \`beta\` | \`money\` | x |
| B | S | (trong \`alpha\`) | — | y |
| C | S | — | \`state\`, \`ledger\` | z |
`;

function fixture({
  doc = DOC,
  modules = ["alpha", "beta"],
  core = ["money", "state", "ledger"],
  files = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "dom-"));
  mkdirSync(join(root, "docs/architecture"), { recursive: true });
  writeFileSync(join(root, "docs/architecture/domains.md"), doc);
  for (const m of modules) mkdirSync(join(root, "apps/backend/src/modules", m), { recursive: true });
  for (const c of core) mkdirSync(join(root, "packages/domain/src", c), { recursive: true });
  for (const f of files) writeFileSync(join(root, "packages/domain/src", f), "export {};\n");
  return root;
}

test("parseDomains đọc cột module và lõi, kể cả ô '(trong ...)' và '—'", () => {
  const { modules, core } = parseDomains(DOC);
  assert.deepEqual([...modules].sort(), ["alpha", "beta"]);
  assert.deepEqual([...core].sort(), ["ledger", "money", "state"]);
});

test("parseDomains: rỗng/null không ném lỗi", () => {
  assert.equal(parseDomains("").modules.size, 0);
  assert.equal(parseDomains(null).core.size, 0);
});

test("khớp hoàn toàn → không lỗi", () => {
  assert.deepEqual(check(fixture()), []);
});

test("module chưa khai → lỗi", () => {
  const errs = check(fixture({ modules: ["alpha", "beta", "gamma"] }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /modules\/gamma chưa khai/);
});

test("thư mục lõi chưa khai → lỗi", () => {
  const errs = check(fixture({ core: ["money", "state", "ledger", "extra"] }));
  assert.match(errs.join("\n"), /packages\/domain\/src\/extra chưa khai/);
});

test("mục khai không tồn tại → lỗi", () => {
  const errs = check(fixture({ modules: ["alpha"] }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /khai `beta` nhưng .*beta không tồn tại/);
});

test("thư mục kỹ thuật trong allowlist được bỏ qua (__tests__)", () => {
  assert.deepEqual(check(fixture({ modules: ["alpha", "beta", "__tests__"] })), []);
});

test("allowlist với lý do rỗng không có hiệu lực", () => {
  const errs = compareSet("m", ["x"], new Set(), { x: "  " });
  assert.equal(errs.length, 1);
});

test("TECH_DIRS: mọi mục có lý do", () => {
  for (const [k, v] of Object.entries({ ...TECH_DIRS, ...CORE_FILES })) assert.ok(v.trim().length >= 10, k);
});

test("thiếu domains.md → ném lỗi", () => {
  const root = mkdtempSync(join(tmpdir(), "dom-"));
  assert.throws(() => check(root), /domains\.md/);
});

test("tên có dấu gạch được khớp nguyên văn", () => {
  const doc = DOC.replaceAll("`alpha`", "`catalog-import`");
  assert.deepEqual(check(fixture({ doc, modules: ["catalog-import", "beta"] })), []);
});

test("file lẻ cấp một của lõi chưa khai → lỗi (miền mới dạng file)", () => {
  const errs = check(fixture({ files: ["inventory.ts"] }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /packages\/domain\/src\/inventory\.ts chưa khai/);
});

test("file lẻ: index.ts, test và file trong CORE_FILES được bỏ qua", () => {
  assert.deepEqual(check(fixture({ files: ["index.ts", "a.test.ts", "units.ts", "result.ts"] })), []);
});

test("file lẻ khai trong bảng thì đạt; khai mà không có file → lỗi", () => {
  const doc = DOC.replace("`money`", "`money`, `inventory.ts`");
  assert.deepEqual(check(fixture({ doc, files: ["inventory.ts"] })), []);
  assert.match(check(fixture({ doc })).join("\n"), /khai `inventory\.ts` nhưng/);
});

test("bảng khác (không có cột Module backend/Lõi thuần) bị bỏ qua", () => {
  const doc = `${DOC}\n| Tên | Ghi chú | \`x\` | \`y\` |\n| --- | --- | --- | --- |\n| a | b | \`zzz\` | \`www\` |\n`;
  assert.deepEqual(check(fixture({ doc })), []);
});

test("hai bảng miền: reset giữa các bảng, cột xác định theo tiêu đề (đảo cột)", () => {
  const doc = `${DOC}\n| Miền | Lõi thuần | Module backend |\n| --- | --- | --- |\n| D | \`extra\` | \`gamma\` |\n`;
  const { modules, core } = parseDomains(doc);
  assert.ok(modules.has("gamma") && core.has("extra"));
  assert.ok(!modules.has("extra") && !core.has("gamma"));
});

test("dòng không phải bảng chen giữa reset trạng thái thân bảng", () => {
  const doc = `${DOC}\nvăn bản\n| a | b | \`q\` | \`r\` |\n`;
  const { modules } = parseDomains(doc);
  assert.ok(!modules.has("q"));
});
