// Test cho check-api-breaking.mjs: repo git tạm + diffSpecs/hasBreakingMarker thuần.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  ALLOWLIST_PATH,
  DECISIONS_PATH,
  diffDetailed,
  diffSpecs,
  hasBreakingMarker,
  OPENAPI_PATH,
  parseLabels,
  run,
} from "./check-api-breaking.mjs";

const SPEC = `
openapi: 3.1.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: "#/components/schemas/A" }
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Req" }
      responses:
        "200": { description: ok }
        "201": { description: created }
  /b:
    get:
      responses:
        "200": { description: ok }
components:
  schemas:
    A:
      type: object
      required: [id]
      properties:
        id: { type: string }
        n: { type: integer }
        kind: { type: string, enum: [x, y] }
        child: { $ref: "#/components/schemas/Node" }
    Node:
      type: object
      properties:
        name: { type: string }
        next: { $ref: "#/components/schemas/Node" }
    Req:
      type: object
      required: [a]
      properties:
        a: { type: string }
        b: { type: string }
`;

const sh = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

function repo(newSpec, { message = "chore: sửa spec" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "api-breaking-"));
  mkdirSync(join(dir, dirname(OPENAPI_PATH)), { recursive: true });
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, OPENAPI_PATH), SPEC);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "chore: gốc");
  sh(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, OPENAPI_PATH), newSpec);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "--allow-empty", "-m", message);
  return dir;
}
const withRepo = (newSpec, opts, fn) => {
  const dir = repo(newSpec, opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const diff = (mutate) => {
  const o = parse(SPEC);
  const n = parse(SPEC);
  mutate(n);
  return diffSpecs(o, n);
};
const has = (list, re) => list.some((x) => re.test(x));

test("không đổi → 0", () => {
  withRepo(SPEC, {}, (dir) => assert.equal(run({ root: dir, base: "master", env: {} }).code, 0));
});

test("xoá path → 1", () => {
  withRepo(
    SPEC.replace(/ {2}\/b:\n {4}get:\n {6}responses:\n {8}"200": \{ description: ok \}\n/, ""),
    {},
    (dir) => {
      const r = run({ root: dir, base: "master", env: {} });
      assert.equal(r.code, 1);
      assert.match(r.lines.join("\n"), /\/b: xoá path/);
    },
  );
});

test("thêm field response → 0", () => {
  withRepo(
    SPEC.replace(
      "        n: { type: integer }\n",
      "        n: { type: integer }\n        extra: { type: string }\n",
    ),
    {},
    (dir) => assert.equal(run({ root: dir, base: "master", env: {} }).code, 0),
  );
});

test("nhãn breaking + BREAKING CHANGE trong thân commit → 0; thiếu một vế → 1", () => {
  const broken = SPEC.replace("        n: { type: integer }\n", "");
  withRepo(broken, { message: "feat(api): bỏ n\n\nBREAKING CHANGE: bỏ field n" }, (dir) => {
    assert.equal(run({ root: dir, base: "master", env: { PR_LABELS: "area:api,Breaking" } }).code, 0);
    assert.equal(run({ root: dir, base: "master", env: { PR_LABELS: "area:api" } }).code, 1);
    assert.equal(run({ root: dir, base: "master", env: {} }).code, 1);
  });
  withRepo(broken, { message: "feat(api): bỏ n" }, (dir) => {
    assert.equal(run({ root: dir, base: "master", env: { PR_LABELS: "breaking" } }).code, 1);
    assert.equal(
      run({ root: dir, base: "master", env: { PR_LABELS: "breaking", PR_TITLE: "feat(api)!: bỏ n" } }).code,
      0,
    );
  });
});

test("base ref không tồn tại → 2", () => {
  withRepo(SPEC, {}, (dir) => assert.equal(run({ root: dir, base: "khong-co", env: {} }).code, 2));
});

test("parseLabels: mảng JSON, danh sách phẩy, rỗng, JSON hỏng", () => {
  assert.deepEqual(parseLabels('["Breaking","area:api"]'), ["breaking", "area:api"]);
  assert.deepEqual(parseLabels("a, B\nc"), ["a", "b", "c"]);
  assert.deepEqual(parseLabels(""), []);
  assert.deepEqual(parseLabels(undefined), []);
  assert.deepEqual(parseLabels("[hỏng"), []);
});

test("hasBreakingMarker", () => {
  assert.ok(hasBreakingMarker("feat!: x"));
  assert.ok(hasBreakingMarker("feat(api)!: x"));
  assert.ok(hasBreakingMarker("feat: x\n\nBREAKING CHANGE: y"));
  assert.ok(hasBreakingMarker("BREAKING-CHANGE: y"));
  assert.ok(!hasBreakingMarker("feat: nhắc BREAKING CHANGE: giữa dòng"));
  assert.ok(!hasBreakingMarker("feat: x"));
  assert.ok(!hasBreakingMarker(""));
});

test("$ref: xoá field trong schema dùng chung/đệ quy bị bắt; vòng $ref không treo", () => {
  const r1 = diff((d) => delete d.components.schemas.Node.properties.name);
  assert.ok(has(r1, /child\.name.*R3/), r1.join("\n"));
  const r2 = diff((d) => (d.components.schemas.Node.properties.name = { type: "integer" }));
  assert.ok(has(r2, /R4/));
  assert.deepEqual(
    diff(() => {}),
    [],
  );
});

test("quy tắc response", () => {
  assert.ok(
    has(
      diff((d) => delete d.paths["/a"].post),
      /P2/,
    ),
  );
  assert.ok(
    has(
      diff((d) => delete d.paths["/a"].post.responses["201"]),
      /R1/,
    ),
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.A.properties.n = { type: "string" })),
      /R4/,
    ),
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.A.properties.n = { type: ["integer", "null"] })),
      /R4/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.components.schemas.A.properties.n = { type: "integer", minimum: 0 })),
    [],
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.A.properties.kind.enum = ["x"])),
      /R6/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.components.schemas.A.properties.kind.enum = ["x", "y", "z"])),
    [],
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.A.required = [])),
      /R5/,
    ),
  );
  assert.ok(
    has(
      diff((d) => delete d.paths["/a"].get.responses["200"].content["application/json"]),
      /R2/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.paths["/a"].get.responses["404"] = { description: "x" })),
    [],
  );
  // Xoá response lỗi (4xx) không tính.
  const o = parse(SPEC);
  o.paths["/a"].get.responses["404"] = { description: "x" };
  assert.deepEqual(diffSpecs(o, parse(SPEC)), []);
});

test("quy tắc request", () => {
  assert.ok(
    has(
      diff((d) => d.components.schemas.Req.required.push("b")),
      /b.*Q3/,
    ),
  );
  assert.ok(
    has(
      diff((d) => {
        d.components.schemas.Req.properties.c = { type: "string" };
        d.components.schemas.Req.required.push("c");
      }),
      /c.*Q3/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.components.schemas.Req.properties.c = { type: "string" })),
    [],
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.Req.properties.a = { type: "integer" })),
      /Q4/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.components.schemas.Req.properties.a = { type: ["string", "null"] })),
    [],
  );
  assert.ok(
    has(
      diff((d) => (d.components.schemas.Req.properties.a = { type: "string", maxLength: 5 })),
      /Q6/,
    ),
  );
  assert.ok(
    has(
      diff(
        (d) =>
          (d.paths["/b"].get.parameters = [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
          ]),
      ),
      /Q1/,
    ),
  );
  assert.deepEqual(
    diff((d) => (d.paths["/b"].get.parameters = [{ name: "q", in: "query", schema: { type: "string" } }])),
    [],
  );
  assert.ok(
    has(
      diff(
        (d) =>
          (d.paths["/b"].get.requestBody = {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          }),
      ),
      /Q2/,
    ),
  );
  assert.ok(
    has(
      diff((d) => {
        delete d.components.schemas.Req.properties.b;
        d.components.schemas.Req.additionalProperties = false;
      }),
      /Q7/,
    ),
  );
});

test("allOf được gộp: xoá field ở nhánh allOf bị bắt", () => {
  const setup = (d) => {
    d.components.schemas.A = {
      allOf: [
        { $ref: "#/components/schemas/Node" },
        { type: "object", properties: { z: { type: "string" } } },
      ],
    };
  };
  const o = parse(SPEC);
  setup(o);
  const n = parse(SPEC);
  setup(n);
  n.components.schemas.A.allOf[1].properties = {};
  assert.ok(has(diffSpecs(o, n), /\.z.*R3/));
});

const BROKEN_N = SPEC.replace("        n: { type: integer }\n", "");
const ENTRY = {
  rule: "R3",
  method: "GET",
  path: "/a",
  location: "response",
  name: "n",
  reason: "Server đã bỏ field này từ trước PR, spec chỉ cập nhật theo.",
  evidence: "apps/backend/src/x.ts:10",
};
const writeAllow = (dir, entries) => {
  mkdirSync(join(dir, dirname(ALLOWLIST_PATH)), { recursive: true });
  writeFileSync(join(dir, ALLOWLIST_PATH), JSON.stringify({ entries }));
};
const runIn = (dir) => run({ root: dir, base: "master", env: {} });

test("allowlist: mục khớp → bỏ qua thay đổi (exit 0); bỏ mục → 1", () => {
  const d = diffDetailed(parse(SPEC), parse(BROKEN_N));
  assert.deepEqual(
    d.map((x) => [x.rule, x.method, x.path, x.location, x.name]),
    [["R3", "GET", "/a", "response", "n"]],
  );
  withRepo(BROKEN_N, {}, (dir) => {
    writeAllow(dir, [ENTRY]);
    assert.equal(runIn(dir).code, 0);
    writeAllow(dir, []);
    assert.equal(runIn(dir).code, 1);
  });
});

test("allowlist: mục thừa (base đã chứa thay đổi) → CẢNH BÁO, exit 0", () => {
  withRepo(SPEC, {}, (dir) => {
    writeAllow(dir, [ENTRY]);
    const r = runIn(dir);
    assert.equal(r.code, 0);
    assert.match(r.lines.join("\n"), /CẢNH BÁO.*thừa.*xoá mục/);
  });
  // Tái hiện lỗi review: sau merge, base == HEAD chứa thay đổi, mục allowlist còn → không được đỏ.
  const dir = repo(BROKEN_N);
  try {
    writeAllow(dir, [ENTRY]);
    assert.equal(run({ root: dir, base: "HEAD", env: {} }).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kiểu: integer→number request không phải thu hẹp; number→integer là thu hẹp", () => {
  const o = parse(SPEC);
  o.components.schemas.Req.properties.a = { type: "integer" };
  const n = parse(SPEC);
  n.components.schemas.Req.properties.a = { type: "number" };
  assert.deepEqual(diffSpecs(o, n), []);
  assert.ok(has(diffSpecs(n, o), /Q4/));
  // response: integer→number là đổi kiểu (rộng hơn), number→integer thì không.
  const ro = parse(SPEC);
  const rn = parse(SPEC);
  rn.components.schemas.A.properties.n = { type: "number" };
  assert.ok(has(diffSpecs(ro, rn), /R4/));
  assert.deepEqual(diffSpecs(rn, ro), []);
});

test("kiểu: response mất `type` → R4; request thêm `type` → Q4", () => {
  assert.ok(
    has(
      diff((d) => (d.components.schemas.A.properties.id = {})),
      /R4/,
    ),
  );
  const o = parse(SPEC);
  o.components.schemas.Req.properties.b = {};
  assert.ok(has(diffSpecs(o, parse(SPEC)), /Q4/));
  assert.deepEqual(diffSpecs(parse(SPEC), o), []);
});

test("Q8: bỏ media type của requestBody", () => {
  const o = parse(SPEC);
  const n = parse(SPEC);
  n.paths["/a"].post.requestBody.content = {
    "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/Req" } },
  };
  const r = diffDetailed(o, n);
  assert.deepEqual(
    r.map((x) => [x.rule, x.location]),
    [["Q8", "body"]],
  );
});

test("$ref vòng qua allOf không tràn stack", () => {
  const cyc = () => {
    const d = parse(SPEC);
    d.components.schemas.Loop = {
      allOf: [
        { $ref: "#/components/schemas/Loop" },
        { type: "object", properties: { x: { type: "string" } } },
      ],
    };
    d.components.schemas.A = { $ref: "#/components/schemas/Loop" };
    return d;
  };
  assert.deepEqual(diffSpecs(cyc(), cyc()), []);
  const n = cyc();
  n.components.schemas.Loop.allOf[1].properties = {};
  assert.ok(has(diffSpecs(cyc(), n), /\.x.*R3/));
});

test("allowlist: thiếu/ngắn reason, thiếu/sai evidence, thiếu trường, JSON hỏng → exit 2", () => {
  withRepo(BROKEN_N, {}, (dir) => {
    for (const bad of [
      { ...ENTRY, reason: "ngắn" },
      { ...ENTRY, reason: undefined },
      { ...ENTRY, evidence: undefined },
      { ...ENTRY, evidence: "không có dòng" },
      { ...ENTRY, name: undefined },
    ]) {
      writeAllow(dir, [bad]);
      assert.equal(runIn(dir).code, 2);
    }
    writeFileSync(join(dir, ALLOWLIST_PATH), "{hỏng");
    assert.equal(runIn(dir).code, 2);
  });
});

test("allowlist: evidence decision:D-NNN hợp lệ khi D-NNN có trong DECISIONS.md; không có → exit 2", () => {
  withRepo(BROKEN_N, {}, (dir) => {
    mkdirSync(join(dir, dirname(DECISIONS_PATH)), { recursive: true });
    writeFileSync(join(dir, DECISIONS_PATH), "### D-146 · 2026-10-30 · quyết định mẫu\n\n- Chọn: x\n");
    writeAllow(dir, [{ ...ENTRY, evidence: "decision:D-146" }]);
    assert.equal(runIn(dir).code, 0);
    writeAllow(dir, [{ ...ENTRY, evidence: "decision:D-999" }]);
    const r = runIn(dir);
    assert.equal(r.code, 2);
    assert.match(r.lines.join("\n"), /D-999/);
    // D-14 không được khớp nhầm tiền tố của D-146.
    writeAllow(dir, [{ ...ENTRY, evidence: "decision:D-14" }]);
    assert.equal(runIn(dir).code, 2);
  });
  withRepo(BROKEN_N, {}, (dir) => {
    // Không có DECISIONS.md → exit 2.
    writeAllow(dir, [{ ...ENTRY, evidence: "decision:D-146" }]);
    assert.equal(runIn(dir).code, 2);
  });
});

test("allowlist tham số request: name là tên tham số", () => {
  const withParam = (max) =>
    SPEC.replace(
      "  /b:\n    get:\n",
      `  /b:\n    get:\n      parameters:\n        - { name: page, in: query, schema: { type: integer${max ? ", maximum: 9999" : ""} } }\n`,
    );
  const d = diffDetailed(parse(withParam(false)), parse(withParam(true)));
  assert.deepEqual(
    d.map((x) => [x.rule, x.method, x.path, x.location, x.name]),
    [["Q6", "GET", "/b", "param", "page"]],
  );
});

test("W1: thêm enum response → cảnh báo, không đỏ", () => {
  const o = parse(SPEC);
  const n = parse(SPEC);
  n.components.schemas.A.properties.kind.enum = ["x", "y", "z"];
  assert.deepEqual(diffSpecs(o, n), []);
  assert.deepEqual(
    diffDetailed(o, n).map((x) => x.rule),
    ["W1"],
  );
  withRepo(SPEC.replace("enum: [x, y]", "enum: [x, y, z]"), {}, (dir) => {
    const r = runIn(dir);
    assert.equal(r.code, 0);
    assert.match(r.lines.join("\n"), /CẢNH BÁO.*W1/);
  });
});

test("chạy CLI (exit code)", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "check-api-breaking.mjs");
  withRepo(SPEC, {}, (dir) => {
    execFileSync("node", [script, "--root", dir, "--base", "master"], { stdio: "pipe" });
  });
  withRepo(SPEC.replace("        n: { type: integer }\n", ""), {}, (dir) => {
    assert.throws(
      () => execFileSync("node", [script, "--root", dir, "--base", "master"], { stdio: "pipe" }),
      (e) => e.status === 1,
    );
  });
});
