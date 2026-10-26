// Kiểm list.mjs + unit.sh (T-128) không cần Postgres/Redis: chạy `node --test scripts/test-shards/`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../..");
const unit = (id, env = {}) =>
  spawnSync("bash", [join(here, "unit.sh"), id], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("list.mjs phủ mọi gói có `test` và mọi file tích hợp http, không trùng", () => {
  const r = spawnSync("node", [join(here, "list.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ids = r.stdout.trim().split("\n");
  assert.equal(new Set(ids).size, ids.length);
  for (const pkg of ["apps/backend", "apps/storefront", "packages/domain"]) {
    assert.ok(ids.includes(`unit:${pkg}`), pkg);
  }
  const specs = readdirSync(join(root, "apps/backend/integration-tests/http")).filter((f) =>
    f.endsWith(".spec.ts"),
  );
  assert.equal(ids.filter((i) => i.startsWith("http:")).length, specs.length);
  assert.ok(ids.includes("http:health"));
});

test("unit.sh từ chối id lạ/thoát thư mục và tham số sai (exit 2, không chạy test)", () => {
  for (const id of [
    "",
    "foo",
    "http:nope",
    "http:../x",
    "http:Health",
    "unit:apps/..",
    "unit:apps/../x",
    "unit:x/y",
  ]) {
    assert.equal(unit(id).status, 2, `id ${JSON.stringify(id)}`);
  }
  for (const cap of ["0", "13", "x", "4 "]) {
    assert.equal(unit("http:health", { XS_TEST_HTTP_JOBS: cap }).status, 2, `cap ${JSON.stringify(cap)}`);
  }
  assert.equal(unit("http:health", { XS_TEST_SLOT_WAIT: "abc" }).status, 2);
});

test("unit.sh: REDIS_URL hỏng → exit 2", () => {
  const slots = mkdtempSync(join(tmpdir(), "xs-slots-"));
  try {
    assert.equal(unit("http:health", { XS_TEST_SLOT_DIR: slots, REDIS_URL: "::bad" }).status, 2);
  } finally {
    rmSync(slots, { recursive: true, force: true });
  }
});

const hasFlock = spawnSync("bash", ["-c", "command -v flock"]).status === 0;
test(
  "unit.sh: mọi ô Redis bận (tiến trình khác giữ) → chờ rồi đỏ, không chạy chung DB",
  { skip: !hasFlock },
  async () => {
    const slots = mkdtempSync(join(tmpdir(), "xs-slots-"));
    const holder = spawn("flock", [join(slots, "redis-1.lock"), "sleep", "10"], { stdio: "ignore" });
    try {
      await new Promise((ok) => setTimeout(ok, 300));
      const t0 = Date.now();
      const r = unit("http:health", {
        XS_TEST_SLOT_DIR: slots,
        XS_TEST_HTTP_JOBS: "1",
        XS_TEST_SLOT_WAIT: "1",
      });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /chờ ô Redis quá 1s/);
      assert.ok(Date.now() - t0 >= 1000);
    } finally {
      holder.kill();
      rmSync(slots, { recursive: true, force: true });
    }
  },
);
