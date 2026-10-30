import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, newDirectDeps, sectionNewDeps } from "./check-new-deps.mjs";

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
