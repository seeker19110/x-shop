import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findViolations, scan, stripComments, validateAllowlist } from "./check-vi-diacritics.mjs";

test("bắt cụm không dấu trong chuỗi, không phân biệt hoa/thường", () => {
  const v = findViolations('const a = "Dang nhap that bai"; const b = <p>Khong tim thay</p>;', "x.tsx");
  assert.deepEqual(
    v.map((x) => x.phrase.toLowerCase()),
    ["dang nhap", "that bai", "khong tim thay"],
  );
  assert.equal(v[0].line, 1);
});

test("chuỗi có dấu không bị bắt (kể cả Unicode dựng sẵn và tổ hợp)", () => {
  assert.deepEqual(findViolations('"Đăng nhập thất bại — Không tìm thấy giỏ hàng"', "x.ts"), []);
  const nfd = "Không tìm thấy".normalize("NFD");
  assert.deepEqual(findViolations(`"${nfd}"`, "x.ts"), []);
});

test("slug URL, identifier và tham số truy vấn không bị tính", () => {
  const src = [
    'href="/gio-hang"',
    'redirect("/tra-cuu-don?loi=lien-ket")',
    "const khong_co = 1; const dangNhap = 2; const gio_hang = 3;",
    'import x from "./thanh-toan/khong"',
    'const u = "Xem don hang cua ban"',
  ].join("\n");
  const phrases = findViolations(src, "x.ts").map((x) => x.phrase);
  assert.deepEqual(phrases, ["don hang"], "chỉ cụm có khoảng trắng trong chuỗi bị bắt");
});

test("comment không bị tính, số dòng được giữ", () => {
  const src = "// khong co gi\n/* dang nhap\n thanh cong */\nconst s = 'khong';\n";
  const v = findViolations(src, "x.ts");
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
});

test("// trong URL của chuỗi không cắt phần còn lại của dòng", () => {
  assert.equal(stripComments('const u = "http://a.b/c"; const m = "khong";').includes("khong"), true);
});

test("allowlist miễn đúng file + đoạn văn bản, file khác vẫn bị bắt", () => {
  const allow = [{ file: "a.ts", contains: "sms:", reason: "SMS GSM-7" }];
  const line = "sms: `Da nhan don, thanh toan khi nhan hang`";
  assert.deepEqual(findViolations(line, "a.ts", allow), []);
  assert.ok(findViolations(line, "b.ts", allow).length > 0);
  assert.ok(findViolations('"khong"', "a.ts", allow).length > 0);
});

test("validateAllowlist: thiếu lý do hoặc sai kiểu → lỗi; rỗng hợp lệ", () => {
  assert.deepEqual(validateAllowlist([]), []);
  assert.equal(validateAllowlist([{ file: "a", contains: "b", reason: "  " }]).length, 1);
  assert.equal(validateAllowlist({}).length, 1);
  assert.equal(validateAllowlist([null]).length, 3);
});

test("allowlist thật của repo hợp lệ", () => {
  const p = join(fileURLToPath(new URL(".", import.meta.url)), "vi-diacritics-allowlist.json");
  assert.deepEqual(validateAllowlist(JSON.parse(readFileSync(p, "utf8"))), []);
});

test("scan bỏ file test/fixture/d.ts và thư mục node_modules; bắt file thường", () => {
  const root = mkdtempSync(join(tmpdir(), "vi-diac-"));
  const src = join(root, "src");
  mkdirSync(join(src, "node_modules"), { recursive: true });
  writeFileSync(join(src, "ui.tsx"), 'export const t = "Dang nhap";\n');
  writeFileSync(join(src, "ui.test.tsx"), 'export const t = "Dang nhap";\n');
  writeFileSync(join(src, "node_modules", "dep.js"), 'export const t = "Dang nhap";\n');
  const v = scan(root, ["src"], []);
  assert.deepEqual(
    v.map((x) => x.file),
    ["src/ui.tsx"],
  );
});

test("scan thư mục rỗng → không vi phạm", () => {
  const root = mkdtempSync(join(tmpdir(), "vi-diac-"));
  mkdirSync(join(root, "src"));
  assert.deepEqual(scan(root, ["src"], []), []);
});
