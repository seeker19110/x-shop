import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyAllowlist, isStaticSql, listSources, main, scanSource, tokenize } from "./check-sql-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const kinds = (src) => scanSource(src).map((f) => f.kind);

test("isStaticSql: literal tĩnh (kể cả nối `+` literal, template không nội suy, rỗng) là an toàn", () => {
  assert.equal(isStaticSql(`"select 1"`), true);
  assert.equal(isStaticSql("`select 1`"), true);
  assert.equal(isStaticSql(`"select " + "1"`), true);
  assert.equal(isStaticSql(""), true);
  assert.equal(isStaticSql("`a $ b`"), true);
});

test("isStaticSql: biến, nội suy, nối biểu thức không an toàn", () => {
  assert.equal(isStaticSql("sql"), false);
  assert.equal(isStaticSql("`select ${x}`"), false);
  assert.equal(isStaticSql(`"select " + id`), false);
  assert.equal(isStaticSql("build()"), false);
});

test("scanSource: raw với literal tĩnh + binding → sạch", () => {
  assert.deepEqual(scanSource('await db.raw("select * from t where id = ?", [id]);'), []);
  assert.deepEqual(scanSource("await db.raw(`select 1`)"), []);
});

test("scanSource: nội suy trong raw bị bắt, kèm số dòng", () => {
  const f = scanSource("const a = 1;\nawait trx.raw(`delete from t where id = '${id}'`);");
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "interpolation");
  assert.equal(f[0].sink, "raw");
  assert.equal(f[0].line, 2);
});

test("scanSource: nối chuỗi vào sink, biến trần vào sink, các sink whereRaw/execute/query", () => {
  assert.deepEqual(kinds('db.raw("select * from t where a = " + a)'), ["concat"]);
  assert.deepEqual(kinds("db.raw(sql, [1])"), ["dynamic"]);
  assert.deepEqual(kinds("q.whereRaw(`${col} > ?`, [1])"), ["interpolation"]);
  assert.deepEqual(kinds("em.execute(sql, params, 'all')"), ["dynamic"]);
  assert.deepEqual(kinds("client.query(text)"), ["dynamic"]);
});

test("scanSource: SQL nội suy ngoài sink (template/chuỗi nối) vẫn bị bắt", () => {
  assert.deepEqual(kinds("const q = `SELECT * FROM t WHERE a = ${a}`;"), ["sql-template"]);
  assert.deepEqual(kinds('const q = "select * from t where a = " + a;'), ["sql-concat"]);
  assert.deepEqual(kinds('const q = a + " delete from t";'), ["sql-concat"]);
});

test("scanSource: không báo trùng literal nằm trong đối số của sink", () => {
  assert.deepEqual(kinds("db.raw(`select ${x}`)"), ["interpolation"]);
});

test("scanSource: chú thích, chuỗi thường, regex, template không SQL không gây báo động giả", () => {
  assert.deepEqual(scanSource("// db.raw(`select ${x}`)\n/* trx.raw(sql) */"), []);
  assert.deepEqual(scanSource('const m = "gọi .raw(x) và select ${y} trong văn bản";'), []);
  assert.deepEqual(scanSource("const r = /[`'\"]select/; db.raw('select 1');"), []);
  assert.deepEqual(scanSource("const s = `Xin chào ${name}, update lúc ${t}`;"), []);
  assert.deepEqual(scanSource("const n = i++ + 1; const s = 'selection' + n;"), []);
});

test("scanSource: template lồng nhau và Unicode không làm lệch vị trí", () => {
  const src = "const t = `${a ? `x ${b}` : ''}`;\nawait db.raw(`select 'tiếng Việt' ${c}`);";
  const f = scanSource(src);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 2);
});

test("scanSource: đối số đầu dừng ở dấu phẩy ngoài cùng (binding không bị coi là đối số đầu)", () => {
  assert.deepEqual(scanSource('db.raw("select ? , ?", [a, `${b}`])'), []);
  assert.deepEqual(
    scanSource("db.raw(fn(a, b), [1])").map((f) => f.text),
    ["fn(a, b)"],
  );
});

test("tokenize: mask tắt trong chuỗi/chú thích; literal ghi nhận nội suy", () => {
  const src = 'a("x"); // y\nb(`z${q}`)';
  const { mask, literals } = tokenize(src);
  assert.equal(mask[src.indexOf('"x"') + 1], 0);
  assert.equal(mask[src.indexOf("// y") + 1], 0);
  assert.equal(literals.find((l) => l.kind === "tpl")?.interp, true);
});

test("applyAllowlist: khớp thì duyệt; không khớp thì chưa duyệt; mục nát bị báo", () => {
  const findings = { "a.ts": [{ line: 1, kind: "interpolation", sink: "raw", text: "`from ${T}`" }] };
  const ok = [{ file: "a.ts", match: "${T}", reason: "T là hằng tên bảng của mã" }];
  assert.deepEqual(applyAllowlist(findings, ok), { unapproved: [], errors: [] });

  assert.equal(applyAllowlist(findings, []).unapproved.length, 1);
  assert.equal(applyAllowlist(findings, [{ ...ok[0], file: "b.ts" }]).unapproved.length, 1);
  assert.equal(applyAllowlist(findings, [{ ...ok[0], kind: "dynamic" }]).unapproved.length, 1);

  const stale = applyAllowlist({}, ok);
  assert.match(stale.errors.join("\n"), /không khớp phát hiện nào/);
});

test("applyAllowlist: lý do trống/ngắn hoặc match trống là lỗi; dynamic so khớp chính xác", () => {
  const findings = { "a.ts": [{ line: 1, kind: "dynamic", sink: "execute", text: "q.sql" }] };
  const errs = applyAllowlist(findings, [
    { file: "a.ts", match: "q.sql", reason: "" },
    { file: "a.ts", match: "", reason: "đủ dài đủ dài đủ dài" },
  ]).errors.join("\n");
  assert.match(errs, /thiếu lý do/);
  assert.match(errs, /thiếu file\/match/);
  const exact = applyAllowlist(findings, [
    { file: "a.ts", kind: "dynamic", match: "sql", reason: "lý do đủ dài ở đây" },
  ]);
  assert.equal(exact.unapproved.length, 1);
});

function fixture(files, allowlist = "[]") {
  const root = mkdtempSync(join(tmpdir(), "sqlsafe-"));
  for (const [f, body] of Object.entries(files)) {
    const p = join(root, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  if (allowlist !== null) writeFileSync(join(root, "scripts/sql-safety-allowlist.json"), allowlist);
  return root;
}

test("listSources: chỉ mã không-test dưới apps|packages/*/src", () => {
  const root = fixture({
    "apps/x/src/a.ts": "",
    "apps/x/src/a.test.ts": "",
    "apps/x/src/__tests__/b.ts": "",
    "apps/x/src/modules/m/migrations/M1.ts": "",
    "apps/x/integration-tests/c.ts": "",
    "packages/y/src/d.ts": "",
    "packages/y/src/e.css": "",
  });
  assert.deepEqual(listSources(root), ["apps/x/src/a.ts", "packages/y/src/d.ts"]);
});

test("main: 0 khi sạch, 1 khi có phát hiện chưa duyệt, 2 khi allowlist hỏng/thiếu", () => {
  assert.equal(main(fixture({ "apps/x/src/a.ts": 'db.raw("select 1");' })), 0);
  assert.equal(main(fixture({ "apps/x/src/a.ts": "db.raw(`select ${id}`);" })), 1);
  assert.equal(main(fixture({ "apps/x/src/a.ts": "" }, "{")), 2);
  assert.equal(main(fixture({ "apps/x/src/a.ts": "" }, null)), 2);
  assert.equal(main(fixture({ "apps/x/src/a.ts": "" }, '{"a":1}')), 2);
});

test("main: phát hiện được duyệt bằng allowlist → 0", () => {
  const al = JSON.stringify([
    { file: "apps/x/src/a.ts", match: "${T}", reason: "T là hằng tên bảng do mã định nghĩa" },
  ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": "db.raw(`select * from ${T}`);" }, al)), 0);
});

test("repo thật: quét sạch (exit 0)", () => {
  const r = spawnSync("node", [join(here, "check-sql-safety.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
