import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkIdempotency, handlersOfSource, keyModeOf, routePathOf } from "./check-idempotency.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = "apps/backend/integration-tests/http/x.spec.ts";
const PARALLEL = "duyệt ×2 song song → một lần duyệt";

const KEYED_SRC = `import { idempotencyKeyOf } from "../http";
export const POST = async (req, res) => { const key = idempotencyKeyOf(req); res.json({ key }); };
`;
const PLAIN_SRC = "export const POST = async (req, res) => { res.json({}); };\n";

const specOf = (ops) =>
  [
    "openapi: 3.1.0",
    'info: { title: t, version: "1" }',
    "paths:",
    ...Object.entries(ops).flatMap(([path, op]) => [
      `  ${path}:`,
      "    post:",
      `      operationId: op${Math.abs(path.length * 7919 + path.charCodeAt(path.length - 1))}`,
      ...(op.mode ? [`      x-idempotency: ${op.mode}`] : []),
      ...(op.keyParam
        ? ["      parameters:", '        - { $ref: "#/components/parameters/IdempotencyKey" }']
        : []),
      "      responses:",
      '        "200": { description: ok }',
      ...(op.conflict ? [`        "409": { $ref: "#/components/responses/${op.conflict}" }`] : []),
      ...(op.validation ? ['        "422": { description: v }'] : []),
    ]),
  ].join("\n") + "\n";

const GOOD_SPEC = {
  "/store/x/things": { mode: "key", keyParam: true, conflict: "KeyedConflict", validation: true },
  "/admin/x/things/{id}/approve": { mode: "state" },
};

/**
 * Cây giả: một route nhận khoá (store/x/things) + một route theo trạng thái (admin/x/things/[id]/approve) trong allowlist
 * kèm file test có ca song song.
 */
function fixture({
  routes = { "store/x/things": KEYED_SRC, "admin/x/things/[id]/approve": PLAIN_SRC },
  allow = [
    {
      route: "POST /admin/x/things/{id}/approve",
      kind: "state",
      reason: "Máy trạng thái: đã duyệt → changed=false, không làm lần hai.",
      tests: [{ file: TEST_FILE, name: PARALLEL }],
    },
  ],
  spec = specOf(GOOD_SPEC),
  testSource = `it("${PARALLEL}", async () => {});\n`,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "idem-"));
  for (const [dir, src] of Object.entries(routes)) {
    mkdirSync(join(root, "apps/backend/src/api", dir), { recursive: true });
    writeFileSync(join(root, "apps/backend/src/api", dir, "route.ts"), src);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/idempotency-allowlist.json"), JSON.stringify({ routes: allow }));
  mkdirSync(join(root, "docs/design"), { recursive: true });
  writeFileSync(join(root, "docs/design/openapi.yaml"), spec);
  mkdirSync(join(root, dirname(TEST_FILE)), { recursive: true });
  writeFileSync(join(root, TEST_FILE), testSource);
  return root;
}

function withFixture(options, fn) {
  const root = fixture(options);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const errorsOf = (options) => withFixture(options, (root) => checkIdempotency({ root }).errors);

test("routePathOf: [param] → {param}, giữ cả route ngoài store/x|admin/x (vd /auth/session)", () => {
  assert.equal(
    routePathOf("/a/api", "/a/api/admin/x/returns/[id]/approve/route.ts"),
    "/admin/x/returns/{id}/approve",
  );
  assert.equal(routePathOf("/a/api", "/a/api/auth/session/route.ts"), "/auth/session");
});

test("handlersOfSource: chỉ handler ghi; nhiều handler → đoạn mã riêng từng handler", () => {
  const src = `const helper = () => idempotencyKeyOf(req);
export const GET = async () => {};
export async function POST(req) { idempotencyKeyOf(req); }
export const DELETE = async (req) => {};
`;
  const hs = handlersOfSource(src);
  assert.deepEqual(
    hs.map((h) => h.method),
    ["POST", "DELETE"],
  );
  assert.equal(keyModeOf(hs[0].body), "key");
  assert.equal(keyModeOf(hs[1].body), null);
  // Một handler ghi duy nhất: hàm phụ khai trước export vẫn được tính.
  const one = handlersOfSource(
    "function k(req) { return idempotencyKeyOf(req); }\nexport const POST = (req) => k(req);\n",
  );
  assert.equal(keyModeOf(one[0].body), "key");
});

test("keyModeOf: req.get('Idempotency-Key') phải kèm isValidIdempotencyKey; không phân biệt hoa thường tên header", () => {
  assert.equal(
    keyModeOf('const k = req.get("Idempotency-Key"); if (!isValidIdempotencyKey(k)) throw 1;'),
    "key",
  );
  assert.equal(keyModeOf("const k = req.get('idempotency-key');"), "unvalidated");
  assert.equal(keyModeOf("res.json({})"), null);
});

test("cây hợp lệ → 0 lỗi, đếm đúng route nhận khoá/allowlist", () => {
  withFixture({}, (root) => {
    const r = checkIdempotency({ root });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(
      { total: r.total, keyed: r.keyed, allowlisted: r.allowlisted },
      { total: 2, keyed: 1, allowlisted: 1 },
    );
  });
});

test("route ghi mới không nhận khoá và không có trong allowlist → lỗi", () => {
  const errors = errorsOf({
    routes: {
      "store/x/things": KEYED_SRC,
      "admin/x/things/[id]/approve": PLAIN_SRC,
      "admin/x/things/[id]/burn": PLAIN_SRC,
    },
  });
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^POST \/admin\/x\/things\/\{id\}\/burn .*không nhận Idempotency-Key và không có trong allowlist/,
  );
});

test("PUT/PATCH/DELETE cũng bị kiểm (không chỉ POST)", () => {
  const errors = errorsOf({
    routes: {
      "store/x/things": KEYED_SRC,
      "admin/x/things/[id]/approve": PLAIN_SRC,
      "admin/x/users/[id]/roles":
        "export const GET = () => {};\nexport const DELETE = () => {};\nexport const PATCH = () => {};\n",
    },
  });
  assert.deepEqual(
    errors.map((e) => e.split(" (")[0]),
    ["DELETE /admin/x/users/{id}/roles", "PATCH /admin/x/users/{id}/roles"],
  );
});

test("mục allowlist không còn route trong mã → lỗi (bỏ mục)", () => {
  const errors = errorsOf({ routes: { "store/x/things": KEYED_SRC } });
  assert.deepEqual(errors, [
    "allowlist POST /admin/x/things/{id}/approve: không còn route trong mã — xoá mục",
  ]);
});

test("route đã nhận khoá mà vẫn nằm trong allowlist → lỗi", () => {
  const errors = errorsOf({
    routes: { "store/x/things": KEYED_SRC, "admin/x/things/[id]/approve": KEYED_SRC },
    spec: specOf({
      ...GOOD_SPEC,
      "/admin/x/things/{id}/approve": {
        mode: "key",
        keyParam: true,
        conflict: "KeyedConflict",
        validation: true,
      },
    }),
  });
  assert.deepEqual(errors, ["POST /admin/x/things/{id}/approve: đã nhận Idempotency-Key — bỏ mục allowlist"]);
});

test("đọc Idempotency-Key mà không kiểm bắt buộc → lỗi", () => {
  const errors = errorsOf({
    routes: {
      "store/x/things": 'export const POST = (req) => { const k = req.get("Idempotency-Key"); };\n',
      "admin/x/things/[id]/approve": PLAIN_SRC,
    },
    spec: specOf({ ...GOOD_SPEC, "/store/x/things": {} }),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /đọc Idempotency-Key nhưng không kiểm bắt buộc/);
});

test("allowlist: kind lạ, lý do ngắn, thiếu test, test không có, trùng mục → lỗi từng điều", () => {
  const base = {
    route: "POST /admin/x/things/{id}/approve",
    kind: "state",
    reason: "Máy trạng thái: đã duyệt → changed=false, không làm lần hai.",
    tests: [{ file: TEST_FILE, name: PARALLEL }],
  };
  const cases = [
    [{ ...base, kind: "trust-me" }, /`kind` phải là một trong state\|natural-key\|no-business-effect/],
    [{ ...base, reason: "ổn" }, /`reason` thiếu hoặc quá ngắn/],
    [{ ...base, tests: [] }, /thiếu `tests`/],
    [
      { ...base, tests: [{ file: "apps/backend/integration-tests/http/khong-co.spec.ts", name: PARALLEL }] },
      /không có file test/,
    ],
    [
      { ...base, tests: [{ file: TEST_FILE, name: "duyệt ×2 song song → tên không có trong file" }] },
      /không có test "/,
    ],
    [{ ...base, route: "GET /admin/x/things" }, /`route` phải dạng "METHOD \/path"/],
  ];
  for (const [entry, re] of cases) {
    const errors = errorsOf({ allow: [entry] });
    assert.ok(
      errors.some((e) => re.test(e)),
      `${re}: ${JSON.stringify(errors)}`,
    );
  }
  const dup = errorsOf({ allow: [base, base] });
  assert.ok(
    dup.some((e) => /trùng mục/.test(e)),
    JSON.stringify(dup),
  );
});

test("allowlist: test được dẫn phải là ca song song (tên có song song/đồng thời/∥/×N)", () => {
  const name = "duyệt hai lần tuần tự → changed=false";
  const errors = errorsOf({
    allow: [
      {
        route: "POST /admin/x/things/{id}/approve",
        kind: "state",
        reason: "Máy trạng thái: đã duyệt → changed=false, không làm lần hai.",
        tests: [{ file: TEST_FILE, name }],
      },
    ],
    testSource: `it("${name}", async () => {});\n`,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /không test nào là ca song song/);
});

test("OpenAPI: route nhận khoá thiếu tham số/409 KeyedConflict/422/x-idempotency → lỗi; allowlist khai sai kind → lỗi", () => {
  const errors = errorsOf({
    spec: specOf({
      "/store/x/things": { mode: "state", conflict: "Conflict" },
      "/admin/x/things/{id}/approve": { mode: "natural-key", keyParam: true },
    }),
  });
  assert.deepEqual(errors, [
    "openapi POST /admin/x/things/{id}/approve: x-idempotency=natural-key (mã/allowlist: state)",
    "openapi POST /admin/x/things/{id}/approve: khai tham số IdempotencyKey nhưng mã không nhận khoá",
    "openapi POST /store/x/things: x-idempotency=state (mã/allowlist: key)",
    "openapi POST /store/x/things: route nhận Idempotency-Key nhưng thiếu tham số IdempotencyKey",
    "openapi POST /store/x/things: phản hồi 409 phải là $ref KeyedConflict (khác nội dung / đang xử lý)",
    "openapi POST /store/x/things: thiếu phản hồi 422 (thiếu/sai Idempotency-Key)",
  ]);
});

test("route ngoài spec (ghi đè route native) vẫn phải nhận khoá hoặc nằm trong allowlist", () => {
  const errors = errorsOf({
    routes: {
      "store/x/things": KEYED_SRC,
      "admin/x/things/[id]/approve": PLAIN_SRC,
      "auth/session": PLAIN_SRC,
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^POST \/auth\/session /);
});

test("CLI: repo thật → exit 0; cây lỗi → exit 1; allowlist hỏng JSON → exit 2", () => {
  const ok = spawnSync("node", [join(here, "check-idempotency.mjs")], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /check-idempotency: OK — \d+ handler ghi: \d+ nhận Idempotency-Key/);

  withFixture({ routes: { "store/x/things": KEYED_SRC } }, (root) => {
    const bad = spawnSync("node", [join(here, "check-idempotency.mjs"), "--root", root], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /không còn route trong mã/);
    writeFileSync(join(root, "scripts/idempotency-allowlist.json"), "{ hỏng");
    const broken = spawnSync("node", [join(here, "check-idempotency.mjs"), "--root", root], {
      encoding: "utf8",
    });
    assert.equal(broken.status, 2);
  });
});
