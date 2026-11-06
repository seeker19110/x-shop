import assert from "node:assert/strict";
import { test } from "node:test";
import { oneLine } from "./log-safe.mjs";

test("oneLine bỏ CR/LF để không giả mạo dòng log", () => {
  assert.equal(oneLine("GET\r\n[lb] giả mạo"), "GET  [lb] giả mạo");
});

test("oneLine bỏ ký tự điều khiển (NUL, ESC, DEL, C1)", () => {
  assert.equal(oneLine("a\u0000b\u001b[31mc\u007fd\u0085e"), "a b [31mc d e");
});

test("oneLine giữ nguyên Unicode thường và ép kiểu null/undefined/rỗng", () => {
  assert.equal(oneLine("/áo-thun?q=đỏ"), "/áo-thun?q=đỏ");
  assert.equal(oneLine(""), "");
  assert.equal(oneLine(null), "null");
  assert.equal(oneLine(undefined), "undefined");
});
