import assert from "node:assert/strict";
import { test } from "node:test";
import { playwrightArgs } from "./args.mjs";

test("bỏ một `--` đứng đầu để bộ lọc spec có tác dụng", () => {
  assert.deepEqual(playwrightArgs(["--", "xss-probe"]), ["xss-probe"]);
});

test("không có `--`: giữ nguyên", () => {
  assert.deepEqual(playwrightArgs(["xss-probe"]), ["xss-probe"]);
  assert.deepEqual(playwrightArgs(["--grep", "@smoke"]), ["--grep", "@smoke"]);
});

test("rỗng: rỗng; chỉ bỏ MỘT `--` đầu, `--` về sau giữ nguyên", () => {
  assert.deepEqual(playwrightArgs([]), []);
  assert.deepEqual(playwrightArgs(["--"]), []);
  assert.deepEqual(playwrightArgs(["--", "--", "x"]), ["--", "x"]);
  assert.deepEqual(playwrightArgs(["a", "--", "b"]), ["a", "--", "b"]);
});
