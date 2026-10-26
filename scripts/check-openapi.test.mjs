import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkOpenapi,
  checkPermissions,
  checkSpecStructure,
  methodsOfSource,
  permissionsInCode,
  routePathOf,
} from "./check-openapi.mjs";

const SPEC = `openapi: 3.1.0
info: { title: t, version: "1" }
paths:
  /store/x/things/{id}:
    get:
      operationId: getThing
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: ok }
  /x/health:
    get:
      operationId: health
      security: []
      responses:
        "200": { description: ok }
`;

/** Dựng cây giả: api/store/x/things/[id]/route.ts + api/x/health/route.ts + permissions.ts rỗng. */
function fixture({ spec = SPEC, healthSource = "export const GET = () => {};" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oa-"));
  const api = join(root, "apps/backend/src/api");
  mkdirSync(join(api, "store/x/things/[id]"), { recursive: true });
  mkdirSync(join(api, "x/health"), { recursive: true });
  mkdirSync(join(api, "admin/x"), { recursive: true });
  mkdirSync(join(root, "docs/design"), { recursive: true });
  writeFileSync(join(api, "store/x/things/[id]/route.ts"), "export const GET = async () => {};\n");
  writeFileSync(join(api, "x/health/route.ts"), healthSource);
  writeFileSync(join(api, "admin/x/permissions.ts"), "export const ADMIN_X_PERMISSIONS = [];\n");
  writeFileSync(join(root, "docs/design/openapi.yaml"), spec);
  return root;
}

function withFixture(options, fn) {
  const root = fixture(options);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("routePathOf: [param] → {param}, giữ tiền tố store/x", () => {
  assert.equal(
    routePathOf("/a/api", "/a/api/store/x/orders/[display_ref]/cancel/route.ts"),
    "/store/x/orders/{display_ref}/cancel",
  );
});

test("methodsOfSource: nhận const và async function, bỏ qua tên khác, không trùng", () => {
  const src = [
    "export const GET = 1;",
    "export async function POST() {}",
    "export const DELETE = 2;",
    "export const get = 3;",
    "export const GETTER = 4;",
    "export const GET2 = 5;",
  ].join("\n");
  assert.deepEqual(methodsOfSource(src), ["delete", "get", "post"]);
  assert.deepEqual(methodsOfSource(""), []);
});

test("checkOpenapi: cây khớp → không lỗi", () => {
  withFixture({}, (root) => {
    const r = checkOpenapi({ root });
    assert.deepEqual(r.errors, []);
    assert.equal(r.operations, 2);
  });
});

test("checkOpenapi: route trong mã thiếu ở spec → báo", () => {
  withFixture({ healthSource: "export const GET = () => {};\nexport const POST = () => {};" }, (root) => {
    const r = checkOpenapi({ root });
    assert.ok(r.errors.some((e) => e.includes("thiếu trong openapi: POST /x/health")));
  });
});

test("checkOpenapi: spec có path mà mã không có route → báo", () => {
  withFixture({ healthSource: "// không export phương thức nào" }, (root) => {
    const r = checkOpenapi({ root });
    assert.ok(r.errors.some((e) => e.includes("không có route trong mã: GET /x/health")));
  });
});

test("checkSpecStructure: phiên bản sai, $ref gãy, operationId trùng, thiếu tham số path, scheme lạ", () => {
  const bad = {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    security: [{ nope: [] }],
    paths: {
      "/a/{id}": {
        get: { operationId: "dup", responses: { 200: { $ref: "#/components/responses/Missing" } } },
        post: { operationId: "dup", responses: { abc: { description: "x" } } },
      },
    },
  };
  const errors = checkSpecStructure(bad).join("\n");
  assert.match(errors, /openapi phải là 3\.1\.x/);
  assert.match(errors, /\$ref không tồn tại: #\/components\/responses\/Missing/);
  assert.match(errors, /operationId trùng/);
  assert.match(errors, /chưa khai tham số đường dẫn \{id\}/);
  assert.match(errors, /mã phản hồi lạ: abc/);
  assert.match(errors, /security scheme chưa định nghĩa: nope/);
  assert.deepEqual(checkSpecStructure(null), ["spec không phải object"]);
});

test("permissionsInCode + checkPermissions: bắt lệch x-permission và route thiếu", () => {
  const perms = permissionsInCode(`
    { method: "GET", path: "/admin/x/things/:id", permission: "catalog.read" },
    {
      method: "POST",
      path: "/admin/x/things",
      permission: "catalog.write",
      also: ["price.write"],
    },
  `);
  assert.equal(perms.get("get /admin/x/things/{id}"), "catalog.read");
  assert.equal(perms.get("post /admin/x/things"), "catalog.write");
  const spec = {
    paths: {
      "/admin/x/things/{id}": { get: { "x-permission": "catalog.write" } },
      "/admin/x/other": { get: { "x-permission": "catalog.read" } },
    },
  };
  const errors = checkPermissions(spec, perms).join("\n");
  assert.match(
    errors,
    /GET \/admin\/x\/things\/\{id\}: x-permission=catalog.write khác permissions.ts \(catalog.read\)/,
  );
  assert.match(errors, /GET \/admin\/x\/other: không có trong permissions.ts/);
  assert.match(errors, /permissions.ts có POST \/admin\/x\/things nhưng openapi thiếu/);
});
