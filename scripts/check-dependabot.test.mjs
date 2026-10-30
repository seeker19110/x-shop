import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { UnsupportedPatternError, check } from "./check-dependabot.mjs";

const put = (root, rel, text = "") => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const dep = (...pairs) =>
  "version: 2\nupdates:\n" +
  pairs
    .map(([e, d]) => `  - package-ecosystem: ${e}\n    directory: ${d}\n    schedule: { interval: weekly }\n`)
    .join("");

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "xt-dep-"));
  put(root, "package.json", "{}");
  put(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  put(root, "apps/a/package.json", "{}");
  put(root, ".github/workflows/ci.yml", "name: ci\n");
  for (const [k, v] of Object.entries(files)) put(root, k, v);
  return root;
}

const withRepo = (files, fn) => {
  const root = repo(files);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true });
  }
};

test("khớp đầy đủ -> không lỗi", () => {
  withRepo(
    {
      Dockerfile: "FROM x",
      ".github/dependabot.yml": dep(
        ["npm", "/"],
        ["npm", "/apps/a"],
        ["github-actions", "/"],
        ["docker", "/"],
      ),
    },
    (root) => assert.deepEqual(check(root), []),
  );
});

test("có Dockerfile mà thiếu docker -> lỗi", () => {
  withRepo(
    {
      Dockerfile: "FROM x",
      ".github/dependabot.yml": dep(["npm", "/"], ["npm", "/apps/a"], ["github-actions", "/"]),
    },
    (root) => assert.match(check(root).join("\n"), /thiếu khối dependabot.*docker \//),
  );
});

test("khai docker mà không còn Dockerfile -> lỗi thừa", () => {
  withRepo(
    {
      ".github/dependabot.yml": dep(
        ["npm", "/"],
        ["npm", "/apps/a"],
        ["github-actions", "/"],
        ["docker", "/"],
      ),
    },
    (root) => assert.match(check(root).join("\n"), /không có manifest.*docker \//),
  );
});

test("thiếu thư mục npm của workspace -> lỗi; directory có dấu / cuối vẫn khớp", () => {
  withRepo({ ".github/dependabot.yml": dep(["npm", "/"], ["github-actions", "/"]) }, (root) =>
    assert.match(check(root).join("\n"), /npm \/apps\/a/),
  );
  withRepo(
    { ".github/dependabot.yml": dep(["npm", "/"], ["npm", "/apps/a/"], ["github-actions", "/"]) },
    (root) => assert.deepEqual(check(root), []),
  );
});

test("không có workflows -> github-actions là thừa; thiếu dependabot.yml -> lỗi", () => {
  withRepo(
    { ".github/dependabot.yml": dep(["npm", "/"], ["npm", "/apps/a"], ["github-actions", "/"]) },
    (root) => {
      rmSync(join(root, ".github/workflows"), { recursive: true });
      assert.match(check(root).join("\n"), /github-actions/);
    },
  );
  withRepo({}, (root) => assert.deepEqual(check(root), ["thiếu .github/dependabot.yml"]));
});

test("mẫu workspace không hỗ trợ -> ném UnsupportedPatternError, không bỏ qua im lặng", () => {
  for (const pat of ["'**'", "apps/**", "a/*/b", "'!apps/x'"]) {
    withRepo(
      { "pnpm-workspace.yaml": `packages:\n  - ${pat}\n`, ".github/dependabot.yml": dep(["npm", "/"]) },
      (root) => assert.throws(() => check(root), UnsupportedPatternError, pat),
    );
  }
});

test("Dockerfile trong node_modules bị bỏ qua", () => {
  withRepo(
    {
      "node_modules/x/Dockerfile": "FROM x",
      ".github/dependabot.yml": dep(["npm", "/"], ["npm", "/apps/a"], ["github-actions", "/"]),
    },
    (root) => assert.deepEqual(check(root), []),
  );
});
