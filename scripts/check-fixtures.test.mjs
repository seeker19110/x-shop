import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isAllowedDomain,
  isFixtureFile,
  listFixtureFiles,
  normalizePhone,
  parseSamplePhones,
  POLICY_PATH,
  scanRepo,
  scanText,
} from "./check-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = new Set(["0912345678"]);
const rules = (text) => scanText(text, SAMPLES).map((f) => f.rule);

// Ví dụ xấu được ghép từ mảnh để chính file test này không chứa email/SĐT dạng thật.
const at = "@";
const realEmail = `nguyen.van.a${at}gmail.com`;

test("isAllowedDomain: tên dành riêng và miền con; miền thật bị từ chối", () => {
  for (const d of [
    "example.test",
    "EXAMPLE.TEST",
    "example.com",
    "mail.example.org",
    "shop.example",
    "x.invalid",
    "app.localhost",
    "x-shop.test",
    "users.noreply.github.com",
  ])
    assert.equal(isAllowedDomain(d), true, d);
  for (const d of ["gmail.com", "example.vn", "x.vn", "notexample.com", "example.com.vn", "test.com", "co"])
    assert.equal(isAllowedDomain(d), false, d);
});

test("scanText: email thật, hoa/thường, nhiều email một dòng; số dòng đúng", () => {
  const f = scanText(`ok a${at}example.test\nx ${realEmail} y B${at}Yahoo.COM`, SAMPLES);
  assert.deepEqual(
    f.map((x) => [x.line, x.rule, x.value]),
    [
      [2, "email", realEmail],
      [2, "email", `B${at}Yahoo.COM`],
    ],
  );
});

test("scanText: email trong template string và email đã che (***) vẫn bị kiểm miền", () => {
  assert.deepEqual(rules("`a-${id}" + at + "shop.vn`"), ["email"]);
  assert.deepEqual(rules(`"n***${at}shop.vn"`), ["email"]);
  assert.deepEqual(rules("`a-${id}" + at + "example.test`"), []);
});

test("scanText: userinfo trong URL, phiên bản gói và decorator không phải email", () => {
  assert.deepEqual(rules(`rediss://default:secret${at}cache.example.vn:6380`), []);
  assert.deepEqual(rules(`postgres://xshop${at}db.internal.vn/xshop`), []);
  assert.deepEqual(rules(`"@types/node${at}22.0.0" "pkg${at}latest" @Injectable.vn`), []);
});

test("scanText: tên file email + đuôi file xét theo miền thật", () => {
  assert.deepEqual(rules(`khach-an${at}example.test.csv`), []);
  assert.deepEqual(rules(`khach-an${at}gmail.com.csv`), ["email"]);
});

test("scanText: SĐT — số mẫu qua mọi dạng viết; số khác bị bắt; số không hợp lệ bỏ qua", () => {
  for (const ok of [
    "0912345678",
    "0912 345 678",
    "0912.345.678",
    "091-234-5678",
    "+84 912 345 678",
    "+84912345678",
    "84912345678",
  ])
    assert.deepEqual(rules(`phone: ${ok}`), [], ok);
  for (const bad of ["0903123456", "+84 987 000 111", "0386 111 222", "0281 234 567"])
    assert.deepEqual(rules(`phone: ${bad}`), ["phone"], bad);
  // 0 + 0/1… không phải đầu số Việt Nam; chuỗi dài hơn 10 số hoặc dính chữ không phải SĐT.
  for (const skip of ["0000000001", "0123456789", "09123456789", "id0903123456", "0903123456x", "1234567890"])
    assert.deepEqual(rules(`v: ${skip}`), [], skip);
});

test("scanText: CCCD 12 số mã tỉnh hợp lệ bị bắt; mã tỉnh ngoài 001–096 và timestamp thì không", () => {
  assert.deepEqual(rules("cccd 001203004567"), ["cccd"]);
  assert.deepEqual(rules("cccd 096100000001"), ["cccd"]);
  assert.deepEqual(rules("v 097100000001 000000000000 1700000000000 x001203004567"), []);
});

test("scanText: rỗng, một dòng, CRLF", () => {
  assert.deepEqual(scanText("", SAMPLES), []);
  assert.equal(scanText(`a\r\n${realEmail}\r\n`, SAMPLES)[0].line, 2);
});

test("normalizePhone và parseSamplePhones", () => {
  assert.equal(normalizePhone("+84 912.345.678"), "0912345678");
  assert.equal(normalizePhone("0912-345-678"), "0912345678");
  const s = parseSamplePhones("| `0912345678` | a |\n| 0987654321 | không backtick |\n`12345` `0900000000`");
  assert.deepEqual([...s].sort(), ["0900000000", "0912345678"]);
  assert.equal(parseSamplePhones("").size, 0);
});

test("isFixtureFile: file dữ liệu thử vào phạm vi; mã sản phẩm, docs và chính script ra ngoài", () => {
  for (const p of [
    "apps/backend/src/lib/x/__tests__/a.unit.spec.ts",
    "packages/domain/src/a.test.ts",
    "apps/backend/integration-tests/helpers/h.ts",
    "e2e/helpers.ts",
    "scripts/ops/drill/seed-before.sql",
    "scripts/load/dataset.mjs",
    "apps/backend/src/scripts/seed.ts",
    "apps/backend/src/scripts/seed-demo.ts",
    "apps/storefront/src/lib/catalog/fixtures.ts",
    "scripts/check-commits.test.mjs",
  ])
    assert.equal(isFixtureFile(p), true, p);
  for (const p of [
    "apps/backend/src/lib/audit/sanitize.ts",
    "docs/ops/RUNBOOK.md",
    "README.md",
    "scripts/check-fixtures.mjs",
    "scripts/check-fixtures.test.mjs",
    "apps/storefront/public/logo.png",
    "e2e/photo.png",
  ])
    assert.equal(isFixtureFile(p), false, p);
});

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "chkfix-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const POLICY = { [POLICY_PATH]: "mẫu: `0912345678`\n" };

test("scanRepo: repo sạch → 0 vi phạm; bỏ qua node_modules, docs và file ngoài phạm vi", () => {
  const root = makeRepo({
    ...POLICY,
    "a/__tests__/ok.test.ts": `const e = "a${at}example.test"; const p = "0912345678";`,
    "a/node_modules/x/leak.test.js": `"${realEmail}"`,
    "docs/note.test.md": realEmail,
    "a/src/service.ts": `// ${realEmail}`,
  });
  try {
    const r = scanRepo(root);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.files, ["a/__tests__/ok.test.ts"]);
    assert.deepEqual(listFixtureFiles(root), r.files);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepo + CLI: seed có email thật → exit 1, in đường dẫn:dòng; sửa sang example.test → exit 0", () => {
  const root = makeRepo({
    ...POLICY,
    "scripts/ops/drill/seed-x.sql": `insert into c(email) values ('${realEmail}');\n`,
  });
  const run = () =>
    spawnSync(process.execPath, [join(here, "check-fixtures.mjs"), root], { encoding: "utf8" });
  try {
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /scripts\/ops\/drill\/seed-x\.sql:1 \[email\]/);
    writeFileSync(
      join(root, "scripts/ops/drill/seed-x.sql"),
      `insert into c(email) values ('a${at}example.test');\n`,
    );
    const good = run();
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /đạt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: thiếu file chính sách hoặc thư mục không tồn tại → exit 2", () => {
  const root = makeRepo({ "a/x.test.ts": "const a = 1;" });
  try {
    const r = spawnSync(process.execPath, [join(here, "check-fixtures.mjs"), root], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /không đọc được đầu vào/);
    const r2 = spawnSync(process.execPath, [join(here, "check-fixtures.mjs"), join(root, "khong-co")], {
      encoding: "utf8",
    });
    assert.equal(r2.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo thật: 0 vi phạm (QA-DATA-002)", () => {
  const r = scanRepo(join(here, ".."));
  assert.deepEqual(
    r.findings.map((f) => `${f.file}:${f.line} ${f.value}`),
    [],
  );
  assert.ok(r.files.length > 50);
});
