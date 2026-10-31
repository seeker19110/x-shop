// Kiểm list.mjs + unit.sh (T-128) không cần Postgres/Redis: chạy `node --test scripts/test-shards/`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assign, medianWeight, parseShard } from "./split.mjs";

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

const list = (...args) => spawnSync("node", [join(here, "list.mjs"), ...args], { encoding: "utf8" });
const lines = (out) => out.split("\n").filter(Boolean);

test("list.mjs --http-shard I/N (T-198): hợp N shard = mọi id http:, rời nhau, không có unit:, tất định", () => {
  const all = lines(list().stdout).filter((i) => i.startsWith("http:"));
  for (const total of [1, 3, 8]) {
    const seen = [];
    for (let k = 1; k <= total; k++) {
      const r = list("--http-shard", `${k}/${total}`);
      assert.equal(r.status, 0, r.stderr);
      const ids = lines(r.stdout);
      assert.ok(ids.length > 0, `shard ${k}/${total} rỗng`);
      assert.ok(
        ids.every((i) => i.startsWith("http:")),
        `shard ${k}/${total} có id không phải http:`,
      );
      assert.deepEqual(lines(list("--http-shard", `${k}/${total}`).stdout), ids, "không tất định");
      seen.push(...ids);
    }
    assert.equal(new Set(seen).size, seen.length, `N=${total}: id trùng giữa shard`);
    assert.deepEqual([...seen].sort(), [...all].sort(), `N=${total}: hợp shard ≠ danh sách đủ`);
  }
});

test("list.mjs --http-shard: shard rỗng khi N > số suite (exit 0); tham số sai → exit 2", () => {
  const n = lines(list().stdout).filter((i) => i.startsWith("http:")).length;
  if (n < 64) {
    const r = list("--http-shard", "64/64");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }
  for (const args of [
    ["--http-shard"],
    ["--http-shard", "0/8"],
    ["--http-shard", "9/8"],
    ["--http-shard", "1/0"],
    ["--http-shard", "1/65"],
    ["--http-shard", "01/8"],
    ["--http-shard", "1/8 "],
    ["--http-shard", "a/b"],
    ["--shard", "1/8"],
    ["--http-shard", "1/8", "x"],
  ]) {
    assert.equal(list(...args).status, 2, JSON.stringify(args));
  }
});

test("split.mjs: LPT cân tải, suite chưa đo nhận trung vị, hoà theo tên, ca biên", () => {
  assert.deepEqual(parseShard("3/8"), { index: 3, total: 8 });
  assert.throws(() => parseShard(null), /I\/N/);
  assert.throws(() => parseShard("8/3"), /1 ≤ I ≤ N/);
  assert.equal(medianWeight({}), 1);
  assert.equal(medianWeight({ a: 1, b: 3, c: 0, d: -2, e: "x", f: Number.NaN }), 2);
  assert.equal(medianWeight({ a: 5, b: 1, c: 9 }), 5);
  // 10 + 6 | 9 + 7 — LPT: 10→0, 9→1, 7→1 (9<10), 6→0.
  const bins = assign(["a", "b", "c", "d"], { a: 10, b: 9, c: 7, d: 6 }, 2);
  assert.deepEqual(
    bins.map((b) => [b.names, b.weight]),
    [
      [["a", "d"], 16],
      [["b", "c"], 16],
    ],
  );
  // Suite mới không có số đo → trung vị (8) chứ không 0: không dồn mọi suite mới vào một shard.
  const withNew = assign(["a", "b", "new1", "new2"], { a: 8, b: 8 }, 2);
  assert.deepEqual(
    withNew.map((b) => b.weight),
    [16, 16],
  );
  // Trọng số bằng nhau → thứ tự theo tên, tất định.
  assert.deepEqual(
    assign(["z", "y", "x"], {}, 3).map((b) => b.names),
    [["x"], ["y"], ["z"]],
  );
  assert.deepEqual(
    assign([], {}, 2).map((b) => b.names),
    [[], []],
  );
  assert.throws(() => assign(["a"], {}, 0), /total/);
  assert.throws(() => assign(["a", "a"], {}, 1), /trùng/);
});

test("http-durations.json: mọi trọng số là số dương; shard nặng nhất ≤ 1,25 × trung bình với N của CI", () => {
  const { seconds } = JSON.parse(readFileSync(join(here, "http-durations.json"), "utf8"));
  assert.ok(Object.keys(seconds).length > 0);
  for (const [k, v] of Object.entries(seconds)) assert.ok(Number.isFinite(v) && v > 0, k);
  const names = lines(list().stdout)
    .filter((i) => i.startsWith("http:"))
    .map((i) => i.slice(5));
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const m = /# integration-coverage-shards\n\s*shard: \[([0-9, ]+)\]/.exec(ci);
  assert.ok(
    m,
    "ci.yml: không thấy matrix shard của integration-coverage (dòng chú thích `# integration-coverage-shards`)",
  );
  const total = m[1].split(",").length;
  const bins = assign(names, seconds, total);
  const mean = bins.reduce((a, b) => a + b.weight, 0) / total;
  const heaviest = Math.max(...bins.map((b) => b.weight));
  assert.ok(heaviest <= 1.25 * mean, `shard nặng nhất ${heaviest}s > 1,25 × trung bình ${mean}s`);
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
