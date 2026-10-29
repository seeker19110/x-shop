// Test hàm thuần của check-scrypt-params.mjs (T-181): node --test scripts/ops/check-scrypt-params.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, main, meetsOwaspScryptMinimum, scryptParamsFromHash } from "./check-scrypt-params.mjs";

/** Header scrypt-kdf giả (chỉ bố cục; salt/checksum/HMAC là 0 — script không kiểm mật mã). */
function fakeHash({ logN, r = 8, p = 1, magic = "scrypt", length = 96 }) {
  const buf = Buffer.alloc(length);
  buf.write(magic, 0, "latin1");
  if (length >= 16) {
    buf.writeUInt8(logN, 7);
    buf.writeUInt32BE(r, 8);
    buf.writeUInt32BE(p, 12);
  }
  return buf.toString("base64");
}

test("đọc logN/r/p từ header; sai định dạng → null", () => {
  assert.deepEqual(scryptParamsFromHash(fakeHash({ logN: 17 })), { logN: 17, r: 8, p: 1 });
  assert.deepEqual(scryptParamsFromHash(fakeHash({ logN: 15, r: 8, p: 3 })), { logN: 15, r: 8, p: 3 });
  assert.equal(scryptParamsFromHash(fakeHash({ logN: 17, magic: "bcrypt" })), null);
  assert.equal(scryptParamsFromHash(fakeHash({ logN: 17, length: 95 })), null);
  assert.equal(scryptParamsFromHash(""), null);
  assert.equal(scryptParamsFromHash(null), null);
  assert.equal(scryptParamsFromHash("$argon2id$v=19$m=19456,t=2,p=1$abc$def"), null);
});

test("mức tối thiểu: logN ≥ 17, r ≥ 8, p ≥ 1", () => {
  assert.equal(meetsOwaspScryptMinimum({ logN: 17, r: 8, p: 1 }), true);
  assert.equal(meetsOwaspScryptMinimum({ logN: 18, r: 8, p: 1 }), true);
  assert.equal(meetsOwaspScryptMinimum({ logN: 16, r: 8, p: 2 }), false);
  assert.equal(meetsOwaspScryptMinimum({ logN: 17, r: 7, p: 1 }), false);
  assert.equal(meetsOwaspScryptMinimum({ logN: 17, r: 8, p: 0 }), false);
});

test("phân loại: rỗng → 0; đạt/dưới chuẩn/sai định dạng tách riêng, đếm theo logN", () => {
  assert.deepEqual(classify([]), { total: 0, ok: 0, below: [], invalid: [], byLogN: {} });
  const r = classify([
    { id: "a", hash: fakeHash({ logN: 17 }) },
    { id: "b", hash: fakeHash({ logN: 15 }) },
    { id: "c", hash: "khong-phai-hash" },
    { id: "d", hash: fakeHash({ logN: 17 }) },
  ]);
  assert.equal(r.total, 4);
  assert.equal(r.ok, 2);
  assert.deepEqual(r.below, ["b"]);
  assert.deepEqual(r.invalid, ["c"]);
  assert.deepEqual(r.byLogN, { 15: 1, 17: 2 });
});

test("thiếu URL → exit 2, không kết nối", async () => {
  const errors = [];
  const code = await main([], {}, { log() {}, error: (m) => errors.push(m) });
  assert.equal(code, 2);
  assert.match(errors[0], /DATABASE_URL/);
});
