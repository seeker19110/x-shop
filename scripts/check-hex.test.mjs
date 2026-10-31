import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findViolations } from "./check-hex.mjs";

const bad = (s, f) => findViolations(s, f).map((v) => `${v.line}:${v.col}`);

test("bắt hex 3/4/6/8 chữ số", () => {
  assert.deepEqual(bad('const a = "#fff", b = "#fffa", c = "#ffffff", d = "#ffffff80";'), [
    "1:12",
    "1:24",
    "1:37",
    "1:52",
  ]);
});
test("bắt CSS khai báo, kể cả toàn chữ số", () => {
  assert.deepEqual(bad("a {\n  color: #111;\n  border: 1px solid #aabbcc;\n}", "a.css"), ["2:10", "3:21"]);
});
test("không bắt id/anchor, entity, url", () => {
  const s = [
    '<a href="#main">x</a>',
    "<a href='#add'>x</a>",
    "&#123; &#x1F600;",
    "fill: url(#cafe)",
    "/trang#faded",
    "?x=#abc",
    "[liên kết](#bad)",
    '<label htmlFor="#bee">',
  ].join("\n");
  assert.deepEqual(bad(s), []);
});
test("không bắt số thứ tự/mã đơn/độ dài sai", () => {
  assert.deepEqual(bad("Đơn #1234 và #123456 và #1"), []);
  assert.deepEqual(bad("Mã #abcde #abcdefabc"), []);
});
test("rgb/hsl cứng bị bắt, dựng từ var thì không", () => {
  assert.deepEqual(bad("a { color: rgb(0 0 0 / 50%); b: HSLA(0,0%,0%,1); }", "a.css"), ["1:12", "1:33"]);
  assert.deepEqual(bad("a { color: rgb(var(--ink) / 50%); }", "a.css"), []);
  assert.deepEqual(bad("const x = rgbValue(1)"), []);
});
test("comment được quét", () => {
  assert.deepEqual(bad("// vd #1a1a1a"), ["1:7"]);
});
test("hex ngay sau dấu hai chấm không dấu cách vẫn bị bắt", () => {
  assert.deepEqual(bad("a{background:#fff}", "a.css"), ["1:14"]);
  assert.deepEqual(bad('el.style.cssText = "color:#e11d48"'), ["1:27"]);
  assert.deepEqual(bad('<p style="color:#000">'), ["1:17"]);
  assert.deepEqual(bad("const C = styled.div`color:#fff;`"), ["1:28"]);
  assert.deepEqual(bad(":root{--x:#fff;}", "a.css"), ["1:11"]);
  assert.deepEqual(bad("$c:#fff;", "a.scss"), ["1:4"]);
  assert.deepEqual(bad("a{color:#111}", "a.css"), ["1:9"]);
  assert.deepEqual(bad('<a href="/x#fade">y</a> https://e.com/p#cafe'), []);
});
test("comment `hex-ok` không còn miễn trừ", () => {
  assert.deepEqual(bad('x = "#fff"; // hex-ok: lý do dài đến đâu cũng không có tác dụng'), ["1:6"]);
});
test("rỗng và CRLF", () => {
  assert.deepEqual(bad(""), []);
  assert.deepEqual(bad('a\r\nb = "#fff"'), ["2:6"]);
});
test("Unicode: cột tính theo đơn vị UTF-16 của chuỗi, dòng đúng", () => {
  assert.deepEqual(bad('"Đỏ đô" #abc'.replace("#abc", '"#abc"')), ["1:10"]);
});

function run(files, list = []) {
  const dir = mkdtempSync(join(tmpdir(), "hex-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const allowFile = join(mkdtempSync(join(tmpdir(), "hexal-")), "a.json");
  writeFileSync(allowFile, typeof list === "string" ? list : JSON.stringify(list));
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-hex.mjs");
  return spawnSync(process.execPath, [script, dir, allowFile], { encoding: "utf8" });
}
const REASON = "Lý do đủ dài để qua ngưỡng hai mươi ký tự.";
test("CLI allowlist: khớp file+pattern thì qua", () => {
  const r = run({ "app/m.ts": 'export const A = "#abc";' }, [
    { file: "app/m.ts", pattern: 'A = "#', reason: REASON },
  ]);
  assert.equal(r.status, 0, r.stderr);
});
test("CLI allowlist: mục thừa (không còn khớp) → 1", () => {
  const r = run({ "app/m.ts": "x = 1" }, [{ file: "app/m.ts", pattern: "#abc", reason: REASON }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mục allowlist thừa/);
});
test("CLI allowlist: sai file hoặc pattern thì vẫn là vi phạm", () => {
  const r = run({ "app/m.ts": 'x = "#abc"' }, [{ file: "app/khac.ts", pattern: "#abc", reason: REASON }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /m\.ts:1:6/);
});
test("CLI allowlist: reason ngắn / thiếu trường → 1; JSON hỏng → 2", () => {
  assert.equal(run({ "a.ts": "x" }, [{ file: "a.ts", pattern: "x", reason: "ngắn" }]).status, 1);
  assert.equal(run({ "a.ts": "x" }, [{ file: "a.ts", reason: REASON }]).status, 1);
  assert.equal(run({ "a.ts": "x" }, "{hỏng").status, 2);
});
test("CLI: sạch → 0; tokens/test/fixtures bỏ qua", () => {
  const r = run({
    "styles/tokens.css": ":root{--a:#fff}",
    "a.test.tsx": 'x="#fff"',
    "__fixtures__/a.ts": 'x="#fff"',
    "ok.tsx": "x=1",
  });
  assert.equal(r.status, 0, r.stderr);
});
test("CLI: vi phạm → 1 và in file:dòng:cột", () => {
  const r = run({ "c/B.tsx": 'const a = 1;\nconst b = "#abc";' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /B\.tsx:2:12:/);
});
test("CLI: thư mục không tồn tại → 2", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-hex.mjs");
  assert.equal(spawnSync(process.execPath, [script, "/không/có/thư/mục"]).status, 2);
});
// T-227: tên màu CSS + color-mix khi là giá trị màu (CSS và inline style JS).
test("T-227 CSS: bắt tên màu ở vế phải thuộc tính màu, báo đúng dòng/cột", () => {
  assert.deepEqual(
    bad(".a {\n  color: red;\n  background: linear-gradient(white, Black);\n}", "a.module.css"),
    ["2:10", "3:31", "3:38"],
  );
  assert.deepEqual(bad(".a { border: 1px solid grey; outline-color: rebeccapurple; --x: tomato }", "a.css"), [
    "1:24",
    "1:45",
    "1:65",
  ]);
});
test("T-227 CSS: giá trị nhiều dòng (box-shadow) và color-mix", () => {
  assert.equal(bad(".a { box-shadow: 0 0 1px var(--c),\n    0 1px 2px black; }", "a.css").join(), "2:15");
  assert.equal(bad(".a { color: color-mix(in srgb, var(--a), var(--b)); }", "a.css").join(), "1:13");
});
test("T-227 CSS: không bắt transparent/currentColor/inherit/var(--red)/url/chuỗi/chú thích/thuộc tính khác", () => {
  const css = [
    ".a { background: transparent; color: currentColor; border-color: inherit; fill: var(--red); }",
    ".b { background: url(red.png); content: 'red'; font-family: Tahoma, Gray; white-space: nowrap; }",
    "/* color: red; */ .c { display: block; grid-area: red; --font: x; }",
    ".red { margin: 0 } .black::before { content: none }",
  ].join("\n");
  assert.deepEqual(bad(css, "a.css"), []);
});
test("T-227 JS: bắt inline style, cssText, el.style.x", () => {
  assert.equal(bad('const a = <p style={{ color: "red", margin: 0 }} />;', "A.tsx").length, 1);
  assert.equal(
    bad("<p style={{ backgroundColor: 'white', border: '1px solid black' }} />", "A.tsx").length,
    2,
  );
  assert.equal(bad('el.style.cssText = "color: red; margin: 0";', "a.ts").length, 1);
  assert.equal(bad('el.style.background = "silver";', "a.ts").length, 1);
  assert.equal(bad('<p style={{ color: "color-mix(in srgb, red, blue)" }} />', "A.tsx").length, 3);
});
test("T-227 JS: không bắt chữ thường trong code/chuỗi UI/dữ liệu/class", () => {
  const js = [
    'const red = 1; const label = "Đen"; const t = "Màu red của áo"; const c = "text-white bg-black";',
    'const p = { name: "black", color: "Đen" }; <p style={{ margin: 0, color: "var(--foreground)" }} />;',
    '<p style={{ color: "transparent", background: "currentColor" }} />;',
  ].join("\n");
  assert.deepEqual(bad(js, "A.tsx"), []);
  assert.deepEqual(bad('x = { color: "red" }', "A.tsx"), []); // ngoài style={{…}}: dữ liệu
});
test("T-227 CLI: color: red trong CSS module → 1; allowlist theo pattern vẫn dùng được", () => {
  const r = run({ "c/B.module.css": ".a {\n  color: red;\n}" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /B\.module\.css:2:10:/);
  const ok = run({ "c/B.module.css": ".a {\n  color: red;\n}" }, [
    { file: "c/B.module.css", pattern: "color: red", reason: REASON },
  ]);
  assert.equal(ok.status, 0, ok.stderr);
});
// T-227 (review): chống backtracking mũ / bậc hai và selector không bị coi là khai báo.
const fast = (name, fn, ms = 100) =>
  test(`T-227 hiệu năng: ${name} < ${ms}ms`, () => {
    const t = process.hrtime.bigint();
    fn();
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < ms);
  });
const BS = "\\".repeat(10000);
fast("CSS chuỗi dở dang nhiều `\\`", () => findViolations(`.a { color: "${BS}x }`, "a.css"));
fast("cssText nhiều `\\`", () => findViolations(`el.style.cssText = "${BS}`, "a.ts"));
fast("style.x nhiều `\\`", () => findViolations(`el.style.color = "${BS}`, "a.ts"));
fast("style={{ chuỗi nhiều `\\`", () => findViolations(`<p style={{ color: "${BS}`, "A.tsx"));
fast("url( lặp", () => findViolations(`.a { background: ${"url(".repeat(20000)}`, "a.css"));
fast("style={{ lặp 8000 lần", () => findViolations("style={{".repeat(8000), "A.tsx"));
fast("chú thích mở lặp", () => findViolations(`.a { color: ${"/*".repeat(20000)}`, "a.css"));
test("T-227 selector chứa tên thuộc tính/màu không bị coi là khai báo", () => {
  assert.deepEqual(bad(".fill:not(.red) { margin: 0 }", "a.css"), []);
  assert.deepEqual(bad(".a,\n.border:hover .white { margin: 0 }", "a.css"), []);
  assert.equal(bad(".a{color:red}.b{fill:blue}", "a.css").length, 2);
});
