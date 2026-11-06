// Test của scripts/perf/opt-gate.sh (T-127) trên một bản clone tạm của chính repo này: commit gốc phải có
// .xtemplates/scripts/xt.py (công cụ chấm khoá) và bộ đo scripts/load, scripts/perf để glob khoá khớp file.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "opt-gate.sh");
const repo = resolve(here, "../..");
const ID = ["-c", "user.email=t@example.invalid", "-c", "user.name=t"];
let tmp;
let clone;
let baseSha;

const git = (cwd, ...args) =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
// Bộ đo giả: bận CPU đúng số ms ghi trong bench-ms.txt (không sleep — guard coi sleep là đáng ngờ).
const BENCH = `import { readFileSync } from "node:fs";
const ms = Number(readFileSync(new URL("./bench-ms.txt", import.meta.url), "utf8"));
const end = performance.now() + ms;
while (performance.now() < end);
`;

function gate(args, cwd = clone) {
  const r = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmp },
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "opt-gate-"));
  clone = join(tmp, "repo");
  const head = git(repo, "rev-parse", "HEAD");
  git(tmp, "clone", "-q", "--local", "--no-checkout", repo, clone);
  git(clone, "checkout", "-q", "--detach", head);
  writeFileSync(join(clone, "bench.mjs"), BENCH);
  writeFileSync(join(clone, "bench-ms.txt"), "250");
  git(clone, "add", "bench.mjs", "bench-ms.txt");
  git(clone, "commit", "-q", "--no-verify", "-m", "bench gốc");
  baseSha = git(clone, "rev-parse", "HEAD");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (extra = []) =>
  gate([baseSha, "--no-install", "--warmup", "1", ...extra, "--", "node", "bench.mjs"]);

test("tham số sai → exit 2: --runs < 10, thiếu lệnh đo, ref gốc không có, tham số lạ", () => {
  assert.equal(gate([baseSha, "--runs", "9", "--", "true"]).code, 2);
  assert.match(gate([baseSha, "--runs", "9", "--", "true"]).out, /≥ 10/);
  assert.equal(gate([baseSha, "--no-install"]).code, 2);
  assert.equal(gate(["khong-co-ref", "--", "true"]).code, 2);
  assert.equal(gate([baseSha, "--bogus", "--", "true"]).code, 2);
});

test("cây sau nhanh hơn rõ rệt → improved, exit 0; setup/teardown chạy ở cả hai cây, cây gốc trước; worktree được dọn", () => {
  writeFileSync(join(clone, "bench-ms.txt"), "25");
  const log = join(tmp, "hooks.log");
  const r = run([
    "--setup",
    `echo "setup $(git rev-parse --show-toplevel)" >> ${log}`,
    "--teardown",
    `echo teardown >> ${log}`,
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /improved:/);
  assert.match(r.out, /10\/10 mẫu/);
  const top = git(clone, "rev-parse", "--show-toplevel");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.notEqual(lines[0], `setup ${top}`, "lượt đầu chạy trong worktree của commit gốc");
  assert.deepEqual(lines.slice(1), ["teardown", `setup ${top}`, "teardown"]);
  assert.equal(git(clone, "worktree", "list").split("\n").length, 1, "không còn worktree tạm");
});

test("cây sau chậm hơn → regressed, exit 1 (hoàn tác)", () => {
  writeFileSync(join(clone, "bench-ms.txt"), "500");
  const r = run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /regressed:/);
});

test("--out ghi before.json/after.json có ≥ 10 mẫu và commit của từng cây", () => {
  writeFileSync(join(clone, "bench-ms.txt"), "25");
  const out = join(tmp, "samples");
  const r = run(["--out", out]);
  assert.equal(r.code, 0, r.out);
  const b = JSON.parse(readFileSync(join(out, "before.json"), "utf8"));
  const a = JSON.parse(readFileSync(join(out, "after.json"), "utf8"));
  assert.equal(b.samples.length, 10);
  assert.equal(a.samples.length, 10);
  assert.equal(b.commit, baseSha);
  assert.deepEqual(a.cmd, b.cmd);
});

test("diff đụng bộ đo khoá (scripts/load) hoặc glob --locked thêm → exit 1 trước khi đo", () => {
  writeFileSync(join(clone, "bench-ms.txt"), "25");
  const env = join(clone, "scripts/load/env.mjs");
  const orig = readFileSync(env, "utf8");
  const out = join(tmp, "guard");
  try {
    writeFileSync(env, `${orig}\n// sửa bộ đo\n`);
    const r = run(["--out", out]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /đụng file khoá.*scripts\/load\/env\.mjs/);
    assert.equal(existsSync(join(out, "before.json")), false, "không đo khi guard đỏ");
  } finally {
    writeFileSync(env, orig);
  }
  const r2 = run(["--locked", "bench-ms.txt"]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /đụng file khoá.*bench-ms\.txt/);
});

test("--setup lỗi → exit 1, teardown vẫn chạy", () => {
  const log = join(tmp, "fail.log");
  const r = run(["--setup", "exit 3", "--teardown", `echo teardown >> ${log}`]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--setup lỗi/);
  assert.equal(readFileSync(log, "utf8").trim(), "teardown");
});
