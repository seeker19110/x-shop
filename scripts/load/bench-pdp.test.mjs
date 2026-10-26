import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkResponse, parseArgs, pdpHandles, publishableKey } from "./bench-pdp.mjs";

test("parseArgs: mặc định 40/1; đọc --requests/--concurrency; ngoài phạm vi, không nguyên, thiếu giá trị, lạ → lỗi", () => {
  assert.deepEqual(parseArgs([]), { requests: 40, concurrency: 1 });
  assert.deepEqual(parseArgs(["--requests", "10", "--concurrency", "4"]), { requests: 10, concurrency: 4 });
  assert.deepEqual(parseArgs(["--requests", "10000", "--concurrency", "64"]), {
    requests: 10_000,
    concurrency: 64,
  });
  for (const bad of [
    ["--requests", "0"],
    ["--requests", "10001"],
    ["--requests", "1.5"],
    ["--requests"],
    ["--concurrency", "65"],
    ["--concurrency", "-1"],
    ["--bogus", "1"],
  ]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(" "));
  }
});

test("pdpHandles: tất định, đúng số lượng, định dạng sp-load-NNNNN, nửa chẵn trong nhóm 500 đầu, mọi số trong 1..products", () => {
  const a = pdpHandles(40, 10_000);
  assert.deepEqual(a, pdpHandles(40, 10_000), "cùng đầu vào → cùng danh sách");
  assert.equal(a.length, 40);
  const nums = a.map((h) => {
    assert.match(h, /^sp-load-\d{5}$/);
    return Number(h.slice(8));
  });
  assert.ok(nums.every((n) => n >= 1 && n <= 10_000));
  assert.ok(
    nums.filter((_, i) => i % 2 === 0).every((n) => n <= 500),
    "chỉ số chẵn thuộc nhóm bán chạy",
  );
  assert.ok(
    nums.some((n, i) => i % 2 === 1 && n > 500),
    "có đuôi dài",
  );
  assert.ok(new Set(nums).size >= 30, "rải đều, ít trùng");
});

test("pdpHandles: ca biên — 0 request → rỗng; products = 1 → mọi handle là 00001; products sai → lỗi", () => {
  assert.deepEqual(pdpHandles(0, 10_000), []);
  assert.deepEqual(pdpHandles(3, 1), ["sp-load-00001", "sp-load-00001", "sp-load-00001"]);
  assert.throws(() => pdpHandles(3, 0), /products/);
  assert.throws(() => pdpHandles(3, 1.5), /products/);
});

test("checkResponse: 200 + đúng handle → null; sai status, thân rỗng/khác handle → lỗi nêu handle", () => {
  assert.equal(checkResponse("sp-load-00001", 200, { handle: "sp-load-00001" }), null);
  assert.match(checkResponse("sp-load-00001", 404, "x"), /sp-load-00001: HTTP 404/);
  assert.match(checkResponse("sp-load-00001", 200, null), /không đúng handle/);
  assert.match(checkResponse("sp-load-00001", 200, { handle: "sp-load-00002" }), /không đúng handle/);
  assert.match(checkResponse("sp-load-00001", 200, "sp-load-00001"), /không đúng handle/);
});

test("publishableKey: ưu tiên biến môi trường, rồi file serve.json; thiếu/hỏng/không có key → lỗi gợi ý serve start", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-pdp-"));
  try {
    const file = join(dir, "serve.json");
    assert.equal(publishableKey({ LOAD_PUBLISHABLE_KEY: "pk_env" }, file), "pk_env");
    assert.throws(() => publishableKey({}, file), /serve\.mjs start/);
    writeFileSync(file, JSON.stringify({ publishableKey: "pk_file" }));
    assert.equal(publishableKey({}, file), "pk_file");
    assert.equal(publishableKey({ LOAD_PUBLISHABLE_KEY: "" }, file), "pk_file", "chuỗi rỗng không tính");
    writeFileSync(file, "{");
    assert.throws(() => publishableKey({}, file), /serve\.mjs start/);
    writeFileSync(file, JSON.stringify({ pid: 1 }));
    assert.throws(() => publishableKey({}, file), /serve\.mjs start/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
