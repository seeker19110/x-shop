import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyAllowlist,
  interpolationExprs,
  isStaticSql,
  listSources,
  main,
  scanSource,
  tokenize,
} from "./check-sql-safety.mjs";

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
    { file: "apps/x/src/a.ts", match: "${T}", idents: ["T"], reason: "T là hằng tên bảng do mã định nghĩa" },
  ]);
  assert.equal(
    main(fixture({ "apps/x/src/a.ts": "const T = 'tbl';\ndb.raw(`select * from ${T}`);" }, al)),
    0,
  );
});

// --- T-179: nội suy `${…}` chỉ là hằng định danh được khai trong allowlist ---

test("interpolationExprs: lấy biểu thức mức ngoài cùng, bỏ qua chuỗi thường và template lồng", () => {
  assert.deepEqual(interpolationExprs("`from ${T} where ${a.b(1, 2)} = ?`"), ["T", "a.b(1, 2)"]);
  assert.deepEqual(interpolationExprs("`${x ? `u ${y}` : ''}`"), ["x ? `u ${y}` : ''"]);
  assert.deepEqual(interpolationExprs('"không ${phải} nội suy"'), []);
  assert.deepEqual(interpolationExprs("`tiếng Việt ${ten} \\${không}`"), ["ten"]);
  assert.deepEqual(interpolationExprs("`không có`"), []);
});

test("scanSource: gắn danh sách biểu thức nội suy; hằng HOA trần phải được khai const/import", () => {
  const ok = scanSource("const TABLE = 't';\ndb.raw(`delete from ${TABLE} where id = ?`, [id]);");
  assert.deepEqual(ok[0].exprs, ["TABLE"]);
  assert.deepEqual(ok[0].undeclared, []);
  const imp = scanSource("import { TABLE } from './t';\ndb.raw(`delete from ${TABLE}`);");
  assert.deepEqual(imp[0].undeclared, []);
  const param = scanSource("function f(TABLE) {\n db.raw(`delete from ${TABLE}`);\n}");
  assert.deepEqual(param[0].undeclared, ["TABLE"]);
  assert.deepEqual(scanSource("db.raw(`select * from t where a = ${a}`)")[0].exprs, ["a"]);
  assert.deepEqual(scanSource('db.raw("select " + col + " from t")')[0].exprs, ["col"]);
});

const IDENT_FINDING = {
  "a.ts": [
    {
      line: 1,
      kind: "interpolation",
      sink: "raw",
      text: "`from ${T} where ${col} = ?`",
      exprs: ["T", "col"],
      undeclared: [],
    },
  ],
};
const entry = (extra) => [
  { file: "a.ts", match: "from ${T}", reason: "T, col là hằng của mã; giá trị qua `?`", ...extra },
];

test("applyAllowlist: mỗi biểu thức nội suy phải được khai trong idents, thiếu → chưa duyệt", () => {
  assert.deepEqual(applyAllowlist(IDENT_FINDING, entry({ idents: ["T", "col"] })), {
    unapproved: [],
    errors: [],
  });
  const missing = applyAllowlist(IDENT_FINDING, entry({ idents: ["T"] }));
  assert.equal(missing.unapproved.length, 1);
  assert.match(missing.unapproved[0].text, /\$\{col\}/);
  assert.equal(applyAllowlist(IDENT_FINDING, entry({})).unapproved.length, 1); // không idents = không được nội suy gì
  assert.equal(applyAllowlist(IDENT_FINDING, entry({ idents: [] })).unapproved.length, 1);
});

test("applyAllowlist: ident thừa/không dùng, idents sai kiểu → lỗi allowlist", () => {
  const stale = applyAllowlist(IDENT_FINDING, entry({ idents: ["T", "col", "khac"] }));
  assert.match(stale.errors.join("\n"), /ident "khac" không dùng/);
  const bad = applyAllowlist(IDENT_FINDING, entry({ idents: ["T", "col", 5, ""] }));
  assert.match(bad.errors.join("\n"), /idents phải là mảng chuỗi/);
  assert.match(
    applyAllowlist(IDENT_FINDING, entry({ idents: "T" })).errors.join("\n"),
    /idents phải là mảng/,
  );
});

test("applyAllowlist: hằng HOA không khai trong tệp (tham số/biến cục bộ) không được allowlist cứu", () => {
  const f = {
    "a.ts": [
      { line: 1, kind: "interpolation", sink: "raw", text: "`from ${T}`", exprs: ["T"], undeclared: ["T"] },
    ],
  };
  const r = applyAllowlist(f, entry({ idents: ["T"] }));
  assert.equal(r.unapproved.length, 1);
  assert.match(r.unapproved[0].text, /không được khai const\/import/);
});

test("main: nội suy biến đến từ tham số/đầu vào bị chặn dù có dòng allowlist không khai idents", () => {
  const src = "export function f(input) {\n  return db.raw(`select * from t order by ${input.sort}`);\n}";
  const noIdents = JSON.stringify([
    { file: "apps/x/src/a.ts", match: "order by", reason: "lý do đủ dài nhưng quên khai idents" },
  ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, noIdents)), 1);
  const withIdents = JSON.stringify([
    {
      file: "apps/x/src/a.ts",
      match: "order by",
      idents: ["input.sort"],
      reason: "lý do đủ dài, đã khai idents",
    },
  ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, withIdents)), 0);
});

test("main: hằng HOA là tham số (không khai const) → 1 kể cả khi allowlist khai idents", () => {
  const src = "export function f(TABLE) {\n  return db.raw(`delete from ${TABLE}`);\n}";
  const al = JSON.stringify([
    { file: "apps/x/src/a.ts", match: "delete from", idents: ["TABLE"], reason: "lý do đủ dài ở đây ok" },
  ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, al)), 1);
});

test("main: whereRaw/knex.raw/template SQL ngoài sink đều chịu kiểm idents; giá trị qua binding thì sạch", () => {
  const al = (extra) =>
    JSON.stringify([{ file: "apps/x/src/a.ts", match: "where", reason: "lý do đủ dài ở đây ok", ...extra }]);
  const where = "const COL = 'c';\nq.whereRaw(`${COL} > ?`, [v]);";
  assert.equal(main(fixture({ "apps/x/src/a.ts": where }, "[]")), 1);
  assert.equal(main(fixture({ "apps/x/src/a.ts": where }, al({ match: "> ?", idents: ["COL"] }))), 0);
  const tpl = "const q = `select * from t where a = ${a}`;";
  assert.equal(main(fixture({ "apps/x/src/a.ts": tpl }, al({ match: "select" }))), 1);
  assert.equal(main(fixture({ "apps/x/src/a.ts": tpl }, al({ match: "select", idents: ["a"] }))), 0);
  assert.equal(
    main(fixture({ "apps/x/src/a.ts": "knex.raw('select * from t where a = ?', [a]);" }, "[]")),
    0,
  );
});

test("repo thật: quét sạch (exit 0)", () => {
  const r = spawnSync("node", [join(here, "check-sql-safety.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
// --- Đợt review T-179: đối số trộn `${}` + `+`, biến trần truy tới khai báo, sink/đầu SQL mở rộng ---

test("scanSource: đối số trộn template `${}` và `+` — phần nối `+ x` cũng phải khai idents", () => {
  const f = scanSource(
    "q.whereRaw(`${COL} < ? ` + (period as any).raw_user_suffix, [to]);\nconst COL = 'c';",
  );
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].exprs, ["COL", "(period as any).raw_user_suffix"]);
  assert.deepEqual(scanSource('db.raw("select * from t where " + cond)')[0].exprs, ["cond"]);
  assert.deepEqual(scanSource("db.raw('select ' + `${A} from ` + B)")[0].exprs, ["A", "B"]);
});

test("main: trộn `${}` + `+` — allowlist chỉ khai phần `${}` thì vẫn đỏ; khai đủ mới xanh", () => {
  const src = "const COL = 'c';\nq.whereRaw(`${COL} < ? ` + suffix, [to]);";
  const al = (idents) =>
    JSON.stringify([
      {
        file: "apps/x/src/a.ts",
        match: "COL",
        idents,
        reason: "lý do đủ dài ở đây ok",
      },
    ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, al(["COL"]))), 1);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, al(["COL", "suffix"]))), 0);
});

test("scanSource: biến trần ở sink truy tới khai báo gần nhất; khởi tạo được kiểm như sink trực tiếp", () => {
  assert.deepEqual(scanSource("const sql = 'select 1';\nq.whereRaw(sql);")[0].exprs, []);
  assert.deepEqual(scanSource("const sql = `select ${x} from t`;\nq.whereRaw(sql);")[0].exprs, ["x"]);
  assert.deepEqual(scanSource("let sql = 'a ' + tail;\nq.whereRaw(sql);")[0].exprs, ["tail"]);
  assert.deepEqual(scanSource("function f(sql) {\n q.whereRaw(sql);\n}")[0].exprs, ["sql"]);
  // khai báo gần nhất thắng (mục `match: sql` không còn phủ mọi `.whereRaw(sql)` trong tệp)
  const two = "const sql = 'a';\nq.whereRaw(sql);\nconst sql2 = 1;\nconst sql = `b ${y}`;\nq.whereRaw(sql);";
  assert.deepEqual(
    scanSource(two).map((f) => f.exprs),
    [[], ["y"]],
  );
});

test("main: mục dynamic `sql` không che khai báo template có nội suy chưa khai idents", () => {
  const src = "const sql = `select * from t where ${w}`;\nq.whereRaw(sql);";
  const al = (idents) =>
    JSON.stringify([
      {
        file: "apps/x/src/a.ts",
        kind: "dynamic",
        match: "sql",
        ...(idents && { idents }),
        reason: "lý do đủ dài ở đây ok",
      },
      // chính template khai báo cũng là một phát hiện (sql-template) và có mục riêng
      { file: "apps/x/src/a.ts", match: "select * from t", idents: ["w"], reason: "lý do đủ dài ở đây ok" },
    ]);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, al(null))), 1);
  assert.equal(main(fixture({ "apps/x/src/a.ts": src }, al(["w"]))), 0);
});

test("scanSource: template SQL mở đầu bằng chú thích hoặc ngoặc vẫn được nhận ra", () => {
  assert.deepEqual(kinds("const q = `-- ghi chú\nSELECT * FROM t WHERE a = ${a}`;"), ["sql-template"]);
  assert.deepEqual(kinds("const q = `/* c */ select ${a}`;"), ["sql-template"]);
  assert.deepEqual(kinds("const q = `(SELECT ${a})`;"), ["sql-template"]);
  assert.deepEqual(kinds("const q = `  -- a\n  -- b\n ( with x as (select ${a}) select 1)`;"), [
    "sql-template",
  ]);
  assert.deepEqual(scanSource("const s = `-- chỉ là ghi chú ${a}`;"), []);
});

test('scanSource: sink fromRaw/andWhereRaw/orHavingRaw, `?.raw(`, `.raw?.(`, `["raw"](` đều bị bắt', () => {
  for (const call of [
    "q.fromRaw(`${a}`)",
    "q.andWhereRaw(`${a}`)",
    "q.orHavingRaw(`${a}`)",
    "q.orWhereRaw(`${a}`)",
    "q.joinRaw(`${a}`)",
    "q?.raw(`${a}`)",
    "q.raw?.(`${a}`)",
    'q["raw"](`${a}`)',
    "q['whereRaw'](`${a}`)",
  ])
    assert.deepEqual(kinds(call), ["interpolation"], call);
  assert.deepEqual(scanSource('q["raw"]("select 1")'), []);
});
