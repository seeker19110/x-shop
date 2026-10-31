import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, directDeps, newDirectDeps, overrideName, sectionNewDeps } from "./check-new-deps.mjs";

const sh = (root, ...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
const pkg = (root, rel, json) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(json));
};

function repo() {
  const root = mkdtempSync(join(tmpdir(), "xt-nd-"));
  sh(root, "init", "-q", "-b", "master");
  sh(root, "config", "user.email", "t@t.t");
  sh(root, "config", "user.name", "t");
  sh(root, "config", "commit.gpgsign", "false");
  pkg(root, "package.json", { dependencies: { a: "1" }, devDependencies: { b: "1" } });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  sh(root, "branch", "base");
  return root;
}

const withRepo = (fn) => {
  const root = repo();
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true });
  }
};

test("không đổi -> không có gói mới", () => {
  withRepo((root) => assert.deepEqual(newDirectDeps(root, "base"), []));
});

test("gói mới ở gốc, workspace con, file mới; bỏ qua workspace: và gói bị xoá", () => {
  withRepo((root) => {
    pkg(root, "package.json", {
      dependencies: { c: "1", "@x/d": "2", e: "workspace:*" },
      devDependencies: {},
    });
    pkg(root, "apps/w/package.json", { devDependencies: { f: "1" } });
    const got = newDirectDeps(root, "base").map((x) => `${x.path}:${x.name}`);
    assert.deepEqual(got, ["apps/w/package.json:f", "package.json:@x/d", "package.json:c"]);
  });
});

test("check: không gói mới -> ok kể cả body rỗng/undefined", () => {
  assert.deepEqual(check([], undefined), []);
  assert.deepEqual(check([], ""), []);
});

test("check: thiếu mục, mục trống, thiếu tên, đủ tên", () => {
  const added = [
    { path: "package.json", name: "@x/d" },
    { path: "package.json", name: "c" },
  ];
  assert.equal(check(added, undefined).length, 1);
  assert.equal(check(added, "## Mục tiêu\nx").length, 1);
  assert.equal(check(added, "## Phụ thuộc mới\n\n## Rủi ro\n@x/d c").length, 2);
  assert.match(check(added, "## Phụ thuộc mới\n- `@x/d`: lý do\n").join(), /'c'/);
  assert.deepEqual(
    check(added, "## Phụ thuộc mới\r\n- `@x/d`: lý do\r\n- c: giấy phép MIT\r\n## Rủi ro\r\n"),
    [],
  );
});

test("check: tên là đoạn của từ khác không tính; chú thích HTML không tính; Unicode", () => {
  const added = [{ path: "package.json", name: "c" }];
  assert.equal(check(added, "## Phụ thuộc mới\ncommon cache").length, 1);
  assert.equal(check(added, "## Phụ thuộc mới\n<!-- c -->\n").length, 1);
  assert.deepEqual(check(added, "## Phụ thuộc mới\nthêm `c` — giấy phép MIT, bảo trì tốt"), []);
  assert.equal(sectionNewDeps("## Phu thuoc moi\nc"), null);
});

test("check: tên không khớp nhờ phần đuôi của gói có scope (react vs @types/react, b vs @a/b)", () => {
  const react = [{ path: "package.json", name: "react" }];
  assert.equal(check(react, "## Phụ thuộc mới\n- @types/react: kiểu").length, 1);
  assert.deepEqual(check(react, "## Phụ thuộc mới\n- @types/react, react: lý do"), []);
  const b = [{ path: "package.json", name: "b" }];
  assert.equal(check(b, "## Phụ thuộc mới\n- @a/b: lý do").length, 1);
});

test("check: dấu câu cuối tên được bỏ; mục có dấu ':'; NFC; tiêu đề trong code fence", () => {
  const c = [{ path: "package.json", name: "zod" }];
  for (const t of ["zod.", "zod,", "zod;", "zod:", "(zod)"]) {
    assert.deepEqual(check(c, `## Phụ thuộc mới\n${t} lý do`), [], t);
  }
  assert.deepEqual(check(c, "## Phụ thuộc mới:\nzod"), []);
  assert.equal(check(c, "## Phụ thuộc mới\nzod.js").length, 1);
  assert.deepEqual(check(c, "## Phụ thuộc mới\nzod".normalize("NFD")), []);
  assert.deepEqual(check(c, "## Phụ thuộc mới\n```\n## Rủi ro\n```\nzod"), []);
  assert.equal(sectionNewDeps("```\n## Phụ thuộc mới\nzod\n```"), null);
});

test("directDeps: optional/peer và pnpm.overrides ở package.json gốc", () => {
  const json = {
    optionalDependencies: { o: "1" },
    peerDependencies: { p: "1" },
    pnpm: { overrides: { "x@<2": "2", "a>@s/y": "1", z: "workspace:*" } },
  };
  assert.deepEqual([...directDeps(json, true)].sort(), ["@s/y", "o", "p", "x"]);
  assert.deepEqual([...directDeps(json, false)].sort(), ["o", "p"]);
});

test("newDirectDeps: override mới ở gốc được tính", () => {
  withRepo((root) => {
    pkg(root, "package.json", {
      dependencies: { a: "1" },
      devDependencies: { b: "1" },
      pnpm: { overrides: { "ov@<3": "3" } },
    });
    assert.deepEqual(
      newDirectDeps(root, "base").map((x) => x.name),
      ["ov"],
    );
  });
});

test("overrideName: `>` trong khoảng phiên bản không phải dấu cha>con", () => {
  assert.equal(overrideName("zod@>=4.0.0 <4.6.6"), "zod");
  assert.equal(overrideName("@graphql-tools/utils@<12.0.2"), "@graphql-tools/utils");
  assert.equal(overrideName("@graphql-codegen/plugin-helpers>lodash"), "lodash");
  assert.equal(overrideName("bullmq>uuid"), "uuid");
  assert.equal(overrideName("a@1>b@>2"), "b");
  assert.equal(overrideName("a>@s/y"), "@s/y");
  assert.equal(overrideName("@s/x@1"), "@s/x");
});

test("sectionNewDeps: chú thích HTML lồng/không đóng không để lộ tên gói", () => {
  assert.equal(sectionNewDeps("## Phụ thuộc mới\n<!<!---->-- `zod` -->\n- `a`").includes("zod"), false);
  assert.equal(sectionNewDeps("## Phụ thuộc mới\n- `a` <!-- `b`").includes("b"), false);
});
