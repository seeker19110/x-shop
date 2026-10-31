import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeRoute,
  checkIdempotency,
  KEYED_SPEC_PATH,
  keyedScenariosOf,
  keyModeOf,
  lastStaticSegment,
  routePathOf,
  testsOfSource,
} from "./check-idempotency.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = "apps/backend/integration-tests/http/x.spec.ts";
const PARALLEL = "duyệt ×2 song song → một lần duyệt";
const PARALLEL_BODY = "const r = await Promise.all([1, 2].map(() => post(`/admin/x/things/${id}/approve`)));";

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
const keyedSpec = (routes) =>
  `const KEYED: Record<string, () => Promise<unknown>> = {\n${routes.map((r) => `  "${r}": async () => ({}),`).join("\n")}\n};\n`;
const ENTRY = {
  route: "POST /admin/x/things/{id}/approve",
  kind: "state",
  reason: "Máy trạng thái: đã duyệt → changed=false, không làm lần hai.",
  tests: [{ file: TEST_FILE, name: PARALLEL }],
};

/**
 * Cây giả: một route nhận khoá (store/x/things, có kịch bản KEYED) + một route theo trạng thái
 * (admin/x/things/[id]/approve) trong allowlist kèm test song song thật. `routes`: thư mục → nguồn route.ts, hoặc
 * { file, src } cho đuôi khác.
 */
function fixture({
  routes = { "store/x/things": KEYED_SRC, "admin/x/things/[id]/approve": PLAIN_SRC },
  allow = [ENTRY],
  spec = specOf(GOOD_SPEC),
  testSource = `it("${PARALLEL}", async () => { ${PARALLEL_BODY} });\n`,
  keyed = keyedSpec(["POST /store/x/things"]),
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "idem-"));
  for (const [dir, r] of Object.entries(routes)) {
    const { file, src } = typeof r === "string" ? { file: "route.ts", src: r } : r;
    mkdirSync(join(root, "apps/backend/src/api", dir), { recursive: true });
    writeFileSync(join(root, "apps/backend/src/api", dir, file), src);
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/idempotency-allowlist.json"), JSON.stringify({ routes: allow }));
  mkdirSync(join(root, "docs/design"), { recursive: true });
  writeFileSync(join(root, "docs/design/openapi.yaml"), spec);
  mkdirSync(join(root, dirname(TEST_FILE)), { recursive: true });
  writeFileSync(join(root, TEST_FILE), testSource);
  writeFileSync(join(root, KEYED_SPEC_PATH), keyed);
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
  assert.equal(routePathOf("/a/api", "/a/api/auth/session/route.js"), "/auth/session");
  assert.equal(lastStaticSegment("POST /store/x/orders/{display_ref}/cancel"), "cancel");
  assert.equal(lastStaticSegment("DELETE /admin/x/users/{id}/roles"), "roles");
});

test("analyzeRoute: thân từng handler tách riêng — GET gọi idempotencyKeyOf không làm POST thành 'key'", () => {
  const src = `export const GET = async (req) => { idempotencyKeyOf(req); };
export async function POST(req) { return 1; }
export const DELETE = async (req) => { idempotencyKeyOf(req); };
`;
  const { handlers, problems } = analyzeRoute(src);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    handlers.map((h) => h.method),
    ["GET", "POST", "DELETE"],
  );
  assert.equal(keyModeOf("export async function POST(req) { return 1; }"), null);
  assert.equal(keyModeOf("export const DELETE = (req) => idempotencyKeyOf(req);"), "key");
  // Hàm phụ ngoài handler: không tính (fail-closed — gọi trong chính handler).
  assert.equal(
    keyModeOf("function k(req) { return idempotencyKeyOf(req); }\nexport const POST = (req) => k(req);\n"),
    null,
  );
});

test("keyModeOf: bỏ chú thích; req.get('Idempotency-Key') phải kèm isValidIdempotencyKey; tên header không phân biệt hoa thường", () => {
  assert.equal(
    keyModeOf("export const POST = (req) => { // TODO idempotencyKeyOf(req)\n return 1; };"),
    null,
  );
  assert.equal(keyModeOf("export const POST = (req) => { /* idempotencyKeyOf(req) */ return 1; };"), null);
  assert.equal(keyModeOf('export const POST = (req) => { const s = "idempotencyKeyOf(req)"; };'), null);
  assert.equal(
    keyModeOf(
      'export const POST = (req) => { const k = req.get("Idempotency-Key"); if (!isValidIdempotencyKey(k)) throw 1; };',
    ),
    "key",
  );
  assert.equal(keyModeOf("export const POST = (req) => req.get('idempotency-key');"), "unvalidated");
  assert.equal(keyModeOf("export const POST = (req, res) => res.json({});"), null);
});

test("fail-closed: export { … }, export *, export let/var, phân rã, export =/default, export import/namespace, exports.* → lỗi", () => {
  for (const src of [
    "const impl = { POST() {} };\nexport = impl;\n",
    "export default { POST: () => {} };\n",
    'import * as Impl from "./impl";\nexport import POST = Impl.POST;\n',
    "export namespace Handlers { export const POST = () => {}; }\n",
    'export { POST } from "./impl";\n',
    "const handler = () => {};\nexport { handler as PATCH };\n",
    'export * from "./impl";\n',
    "export let PUT = () => {};\n",
    "export var helper = 1;\n",
    "export const { POST } = impl;\n",
  ]) {
    const errors = errorsOf({
      routes: { "store/x/things": KEYED_SRC, "admin/x/things/[id]/approve": PLAIN_SRC, "admin/x/evil": src },
    });
    assert.ok(
      errors.some((e) => e.startsWith("apps/backend/src/api/admin/x/evil/route.ts: ")),
      `${src}: ${JSON.stringify(errors)}`,
    );
  }
  // CommonJS trong route.js: exports.X / module.exports / module.exports.X / exports["X"].
  for (const src of [
    "exports.POST = async (req, res) => res.json({});\n",
    "module.exports = { POST: async () => {} };\n",
    "module.exports.DELETE = async () => {};\n",
    'exports["PUT"] = async () => {};\n',
  ]) {
    const errors = errorsOf({
      routes: {
        "store/x/things": KEYED_SRC,
        "admin/x/things/[id]/approve": PLAIN_SRC,
        "admin/x/evil": { file: "route.js", src },
      },
    });
    assert.ok(
      errors.some((e) => e.startsWith("apps/backend/src/api/admin/x/evil/route.js: ")),
      `${src}: ${JSON.stringify(errors)}`,
    );
  }
});

test("quét cả route.js/.mjs (Medusa nạp .js) — route ghi .js thiếu khoá → lỗi", () => {
  const errors = errorsOf({
    routes: {
      "store/x/things": KEYED_SRC,
      "admin/x/things/[id]/approve": PLAIN_SRC,
      "admin/x/burn": { file: "route.js", src: "export const POST = async (req, res) => res.json({});\n" },
      "admin/x/melt": { file: "route.mjs", src: "export async function DELETE(req, res) {}\n" },
    },
  });
  assert.deepEqual(
    errors.map((e) => e.split(" (")[0]),
    ["DELETE /admin/x/melt", "POST /admin/x/burn"],
  );
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

test("route nhận khoá phải có kịch bản trong KEYED của idempotency.spec; KEYED thừa → lỗi", () => {
  const missing = errorsOf({ keyed: keyedSpec([]) });
  assert.equal(missing.length, 1);
  assert.match(
    missing[0],
    /^POST \/store\/x\/things: route nhận Idempotency-Key nhưng thiếu kịch bản trong KEYED/,
  );
  const extra = errorsOf({ keyed: keyedSpec(["POST /store/x/things", "POST /store/x/ghost"]) });
  assert.equal(extra.length, 1);
  assert.match(extra[0], /^KEYED "POST \/store\/x\/ghost"/);
  assert.deepEqual([...keyedScenariosOf(keyedSpec(["POST /a", "DELETE /b"]))], ["POST /a", "DELETE /b"]);
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
    keyed: keyedSpec(["POST /store/x/things", "POST /admin/x/things/{id}/approve"]),
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
    keyed: keyedSpec([]),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /đọc Idempotency-Key nhưng không kiểm bắt buộc/);
});

test("allowlist: kind lạ, lý do ngắn, thiếu test, file test không có, trùng mục, route sai dạng → lỗi từng điều", () => {
  const cases = [
    [{ ...ENTRY, kind: "trust-me" }, /`kind` phải là một trong state\|natural-key\|no-business-effect/],
    [{ ...ENTRY, reason: "ổn" }, /`reason` thiếu hoặc quá ngắn/],
    [{ ...ENTRY, tests: [] }, /thiếu `tests`/],
    [
      { ...ENTRY, tests: [{ file: "apps/backend/integration-tests/http/khong-co.spec.ts", name: PARALLEL }] },
      /không có file test/,
    ],
    [{ ...ENTRY, route: "GET /admin/x/things" }, /`route` phải dạng "METHOD \/path"/],
    [{ ...ENTRY, calls: "doIt" }, /`calls` khai theo từng mục `tests\[\]`/],
    [
      { ...ENTRY, tests: [{ file: TEST_FILE, name: PARALLEL, calls: ".*" }] },
      /`tests\[\]\.calls` phải là tên hàm phụ/,
    ],
  ];
  for (const [entry, re] of cases) {
    const errors = errorsOf({ allow: [entry] });
    assert.ok(
      errors.some((e) => re.test(e)),
      `${re}: ${JSON.stringify(errors)}`,
    );
  }
  const dup = errorsOf({ allow: [ENTRY, ENTRY] });
  assert.ok(
    dup.some((e) => /trùng mục/.test(e)),
    JSON.stringify(dup),
  );
});

test("allowlist: tên chỉ nằm trong chú thích/chuỗi khác, it.skip/xit/it.todo/describe.skip → không chứng minh", () => {
  const body = `async () => { ${PARALLEL_BODY} }`;
  const cases = [
    [`// "${PARALLEL}"\nit("ca khác hẳn", ${body});\n`, /không có lời gọi it\(\/test\( tên/],
    [`const s = "${PARALLEL}";\n`, /không có lời gọi it\(\/test\( tên/],
    [`it.skip("${PARALLEL}", ${body});\n`, /bị skip\/todo/],
    [`xit("${PARALLEL}", ${body});\n`, /bị skip\/todo/],
    [`it.todo("${PARALLEL}");\n`, /bị skip\/todo/],
    [`describe.skip("nhóm", () => { test("${PARALLEL}", ${body}); });\n`, /bị skip\/todo/],
  ];
  for (const [testSource, re] of cases) {
    const errors = errorsOf({ testSource });
    assert.ok(
      errors.some((e) => re.test(e)),
      `${testSource}: ${JSON.stringify(errors)}`,
    );
  }
  // Đối chứng: describe thường + test(…) → đạt.
  assert.deepEqual(
    errorsOf({ testSource: `describe("nhóm", () => { test("${PARALLEL}", ${body}); });\n` }),
    [],
  );
});

test("allowlist: test được dẫn phải gọi route song song — Promise.all thật (AST) + literal đủ đường dẫn, hoặc hàm phụ `calls` chứa literal", () => {
  const T = (body, extra = "") => `${extra}it("${PARALLEL}", async () => { ${body} });\n`;
  const bad = (opts) => {
    const errors = errorsOf(opts);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /test "duyệt ×2 song song → một lần duyệt" không gọi route song song/);
  };
  // Không Promise.all.
  bad({ testSource: T("await post(`/admin/x/things/${id}/approve`);") });
  // Route khác (đuôi khác).
  bad({ testSource: T('await Promise.all([post("/admin/x/things/1/reject")]);') });
  // (A4) Cùng đuôi `approve` nhưng tiền tố khác.
  bad({ testSource: T("await Promise.all([post(`/admin/x/others/${id}/approve`)]);") });
  bad({ testSource: T('await Promise.all([post("/admin/x/approve")]);') });
  // (A5) Chỉ trong chú thích, thân không làm gì.
  bad({ testSource: T("// Promise.all(post(`/admin/x/things/${id}/approve`))\nexpect(1).toBe(1);") });
  bad({ testSource: T("/* Promise.all */ await post(`/admin/x/things/${id}/approve`);") });
  // "Promise.all" chỉ là chuỗi.
  bad({ testSource: T('const s = "Promise.all"; await post(`/admin/x/things/${id}/approve`);') });
  // Đạt: literal thường/template, kèm query string.
  assert.deepEqual(
    errorsOf({ testSource: T('await Promise.all([post("/admin/x/things/42/approve?x=1")]);') }),
    [],
  );
  assert.deepEqual(
    errorsOf({
      testSource: T("const url = `/admin/x/things/${id}/approve`;\nawait Promise.allSettled([post(url)]);"),
    }),
    [],
  );

  // Hàm phụ: `calls` = tên hàm, phải được gọi trong test VÀ khai trong cùng file có literal đủ đường dẫn.
  const helper = "const doIt = (id) => api.post(`/admin/x/things/${id}/approve`);\n";
  const viaHelper = T("await Promise.all([doIt(1), doIt(1)]);", helper);
  const withCalls = (calls) => [{ ...ENTRY, tests: [{ file: TEST_FILE, name: PARALLEL, calls }] }];
  bad({ testSource: viaHelper });
  assert.deepEqual(errorsOf({ testSource: viaHelper, allow: withCalls("doIt") }), []);
  // (A3) Hàm phụ trỏ route khác / không được gọi / không khai trong file.
  bad({
    testSource: T(
      "await Promise.all([doIt(1)]);",
      "const doIt = (id) => api.post(`/admin/x/things/${id}/confirm`);\n",
    ),
    allow: withCalls("doIt"),
  });
  bad({ testSource: T("await Promise.all([other(1)]);", helper), allow: withCalls("doIt") });
  bad({ testSource: T("await Promise.all([doIt(1)]);"), allow: withCalls("doIt") });

  // MỌI test được dẫn phải chứng minh: thêm một test không liên quan → lỗi dù test kia đạt.
  const errors = errorsOf({
    testSource:
      T("await Promise.all([post(`/admin/x/things/${id}/approve`)]);") +
      'it("ca không liên quan gì", async () => {});\n',
    allow: [{ ...ENTRY, tests: [...ENTRY.tests, { file: TEST_FILE, name: "ca không liên quan gì" }] }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /test "ca không liên quan gì" không gọi route song song/);

  assert.deepEqual(
    testsOfSource(`test("a b c d e f", async () => { x(); });\nit(\`tpl \${v}\`, () => {});\n`).map(
      (t) => t.name,
    ),
    ["a b c d e f"],
  );
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
