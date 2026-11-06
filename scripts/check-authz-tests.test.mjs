import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  checkAuthzCoverage,
  checkAuthzTests,
  classifyOperations,
  parseTags,
  requiredRoutes,
} from "./check-authz-tests.mjs";

const SPEC_YAML = `openapi: 3.1.0
info: { title: t, version: "1" }
security:
  - publishableKey: []
paths:
  /store/x/products:
    get: { operationId: a, responses: { "200": { description: ok } } }
  /store/x/checkout/submit:
    post: { operationId: b, responses: { "200": { description: ok } } }
  /store/x/orders/{display_ref}:
    get:
      operationId: c
      security: [{ publishableKey: [], orderAccess: [] }]
      responses: { "200": { description: ok } }
  /admin/x/returns:
    get:
      operationId: d
      security: [{ adminSession: [] }, { adminBearer: [] }]
      responses: { "200": { description: ok } }
    post:
      operationId: e
      security: [{ adminSession: [] }, { adminBearer: [] }]
      responses: { "200": { description: ok } }
  /x/health:
    get: { operationId: f, security: [], responses: { "200": { description: ok } } }
`;
const spec = parse(SPEC_YAML);

const full = [
  { tag: "api5-bfla", selector: "admin:*" },
  { tag: "api1-bola", selector: "order:*" },
  { tag: "api1-bola", selector: "post /store/x/checkout/submit" },
];

test("phân loại: admin, đơn, công khai chạm giỏ; sản phẩm/health không bắt buộc", () => {
  const req = requiredRoutes(classifyOperations(spec));
  assert.deepEqual(req["api5-bfla"].sort(), ["get /admin/x/returns", "post /admin/x/returns"]);
  assert.deepEqual(req["api1-bola"].sort(), [
    "get /store/x/orders/{display_ref}",
    "post /store/x/checkout/submit",
  ]);
});

test("đủ tag → không lỗi", () => {
  assert.deepEqual(checkAuthzCoverage(spec, full), []);
});

test("thiếu tag cho một route → đỏ, nêu đúng route", () => {
  const errors = checkAuthzCoverage(spec, full.slice(0, 2));
  assert.deepEqual(errors, ["thiếu test api1-bola cho post /store/x/checkout/submit"]);
});

test("không có test nào → đỏ cho mọi route bắt buộc", () => {
  assert.equal(checkAuthzCoverage(spec, []).length, 4);
});

test("tag sai loại không bù cho tag kia (bola không thay bfla)", () => {
  const errors = checkAuthzCoverage(spec, [
    { tag: "api1-bola", selector: "admin:*" },
    { tag: "api1-bola", selector: "order:*" },
    { tag: "api1-bola", selector: "post /store/x/checkout/submit" },
  ]);
  assert.deepEqual(errors, [
    "thiếu test api5-bfla cho get /admin/x/returns",
    "thiếu test api5-bfla cho post /admin/x/returns",
  ]);
});

test("selector trỏ route không có thật → lỗi (tag mồ côi); parseTags hạ chữ thường", () => {
  const tags = parseTags(`it("[api1-bola POST /store/x/khong-co]", () => {});`);
  assert.deepEqual(tags, [{ tag: "api1-bola", selector: "post /store/x/khong-co" }]);
  const errors = checkAuthzCoverage(spec, [...full, ...tags]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /selector không hợp lệ.*post \/store\/x\/khong-co/);
});

test("parseTags: chỉ tính trong chuỗi, bỏ chú thích; nhiều selector; Unicode", () => {
  const src = [
    "// [api5-bfla admin:*] trong chú thích không tính",
    'describe("map quyền ✓ đơn hàng [api5-bfla admin:*] tiếng Việt", () => {',
    "  it(`[api1-bola order:*, post /store/x/checkout/submit] giỏ của người khác`, () => {});",
    "  it('[api2-khac admin:*] tag lạ bị bỏ', () => {});",
    "});",
  ].join("\n");
  assert.deepEqual(parseTags(src), [
    { tag: "api5-bfla", selector: "admin:*" },
    { tag: "api1-bola", selector: "order:*" },
    { tag: "api1-bola", selector: "post /store/x/checkout/submit" },
  ]);
  assert.deepEqual(parseTags(""), []);
});

test("OpenAPI không có route admin/đơn → đỏ (không xanh giả)", () => {
  const empty = parse("openapi: 3.1.0\ninfo: { title: t, version: '1' }\npaths: {}\n");
  assert.equal(checkAuthzCoverage(empty, []).length, 2);
});

test("checkAuthzTests đọc cây thật: có tag → đạt; bỏ tag → đỏ; thiếu OpenAPI → ném lỗi", () => {
  const root = mkdtempSync(join(tmpdir(), "authz-"));
  try {
    mkdirSync(join(root, "docs/design"), { recursive: true });
    mkdirSync(join(root, "apps/backend/integration-tests/http"), { recursive: true });
    writeFileSync(join(root, "docs/design/openapi.yaml"), SPEC_YAML);
    const f = join(root, "apps/backend/integration-tests/http/x.spec.ts");
    writeFileSync(
      f,
      'it("[api5-bfla admin:*] a", () => {});\nit("[api1-bola order:*, post /store/x/checkout/submit] b", () => {});\n',
    );
    assert.deepEqual(checkAuthzTests({ root }).errors, []);
    writeFileSync(f, 'it("[api5-bfla admin:*] a", () => {});\n');
    assert.equal(checkAuthzTests({ root }).errors.length, 2);
    rmSync(join(root, "docs/design/openapi.yaml"));
    assert.throws(() => checkAuthzTests({ root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
