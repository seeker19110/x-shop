import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  baselineAtRef,
  compare,
  compareBaselines,
  main,
  parseSummary,
  raise,
  validateBaseline,
} from "./coverage-ratchet.mjs";

const summary = (lines, branches) =>
  JSON.stringify({ total: { lines: { pct: lines }, branches: { pct: branches } } });
const base = (packages) => ({ packages });
const quiet = () => {
  const out = { log: [], error: [] };
  return { out, log: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) } };
};

function fixture(packages, measured) {
  const root = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
  writeFileSync(join(root, "coverage-baseline.json"), JSON.stringify(base(packages)));
  for (const [dir, v] of Object.entries(measured)) {
    mkdirSync(join(root, dir, "coverage"), { recursive: true });
    writeFileSync(join(root, dir, "coverage", "coverage-summary.json"), summary(v.lines, v.branches));
  }
  return root;
}

test("parseSummary: đọc total.lines/branches.pct; 0 và 100 hợp lệ; thiếu/không số/ngoài 0–100/JSON hỏng → lỗi", () => {
  assert.deepEqual(parseSummary(summary(91.01, 80.99)), { lines: 91.01, branches: 80.99 });
  assert.deepEqual(parseSummary(summary(0, 100)), { lines: 0, branches: 100 });
  assert.throws(
    () => parseSummary(JSON.stringify({ total: { lines: { pct: 50 } } })),
    /total\.branches\.pct/,
  );
  assert.throws(() => parseSummary(summary("Unknown", 50)), /total\.lines\.pct/);
  assert.throws(() => parseSummary(summary(null, 50)), /total\.lines\.pct/);
  assert.throws(() => parseSummary(summary(100.01, 50)), /total\.lines\.pct/);
  assert.throws(() => parseSummary(summary(-1, 50)), /total\.lines\.pct/);
  assert.throws(() => parseSummary("{"), /JSON không hợp lệ/);
  assert.throws(() => parseSummary(""), /JSON không hợp lệ/);
});

test("validateBaseline: rỗng/thiếu packages/mảng/chỉ số không phải số → lỗi", () => {
  assert.throws(() => validateBaseline({}), /packages/);
  assert.throws(() => validateBaseline(null), /packages/);
  assert.throws(() => validateBaseline({ packages: {} }), /packages/);
  assert.throws(() => validateBaseline({ packages: [] }), /packages/);
  assert.throws(() => validateBaseline(base({ a: { lines: 1 } })), /a"\]\.branches/);
  assert.throws(() => validateBaseline(base({ a: { lines: "90", branches: 80 } })), /a"\]\.lines/);
  assert.doesNotThrow(() => validateBaseline(base({ a: { lines: 0, branches: 0 } })));
});

test("compare: bằng baseline đạt; thấp hơn 0,01 ở branches hoặc lines → đỏ; cao hơn → improved; thiếu summary → đỏ", () => {
  const b = base({ a: { lines: 90, branches: 80 }, b: { lines: 50, branches: 50 } });
  assert.deepEqual(
    compare(b, { a: { lines: 90, branches: 80 }, b: { lines: 50, branches: 50 } }).failures,
    [],
  );
  const drop = compare(b, { a: { lines: 90, branches: 79.99 }, b: { lines: 49.99, branches: 50 } });
  assert.deepEqual(drop.failures, [
    "a: branches 79.99 % < baseline 80 %",
    "b: lines 49.99 % < baseline 50 %",
  ]);
  const up = compare(b, { a: { lines: 91, branches: 80 }, b: { lines: 50, branches: 50 } });
  assert.deepEqual(up.failures, []);
  assert.deepEqual(up.improved, ["a: lines 90 % → 91 %"]);
  const missing = compare(b, { a: { lines: 90, branches: 80 }, b: null });
  assert.equal(missing.failures.length, 1);
  assert.match(missing.failures[0], /^b: thiếu coverage/);
  assert.match(compare(b, {}).failures.join("\n"), /a: thiếu[\s\S]*b: thiếu/);
});

test("raise: chỉ tăng từng chỉ số, giữ gói không đo được, thêm gói mới, giữ trường khác", () => {
  const b = { measured: "x", packages: { a: { lines: 90, branches: 80 }, c: { lines: 10, branches: 10 } } };
  const next = raise(b, { a: { lines: 85, branches: 82 }, n: { lines: 1, branches: 0 } });
  assert.deepEqual(next, {
    measured: "x",
    packages: {
      a: { lines: 90, branches: 82 },
      c: { lines: 10, branches: 10 },
      n: { lines: 1, branches: 0 },
    },
  });
  assert.deepEqual(b.packages.a, { lines: 90, branches: 80 }, "không sửa object đầu vào");
});

test("compareBaselines: hạ một chỉ số hoặc xoá gói → lỗi; giữ nguyên/tăng/thêm gói → đạt", () => {
  const prev = base({ a: { lines: 90, branches: 80 }, b: { lines: 50, branches: 50 } });
  assert.deepEqual(compareBaselines(prev, prev), []);
  assert.deepEqual(
    compareBaselines(
      prev,
      base({ a: { lines: 95, branches: 80 }, b: { lines: 50, branches: 51 }, c: { lines: 0, branches: 0 } }),
    ),
    [],
  );
  assert.deepEqual(
    compareBaselines(prev, base({ a: { lines: 90, branches: 79.5 }, b: { lines: 50, branches: 50 } })),
    ["a: baseline branches bị hạ 80 % → 79.5 %"],
  );
  assert.deepEqual(compareBaselines(prev, base({ a: { lines: 90, branches: 80 } })), [
    "b: bị xoá khỏi baseline (bản cũ có)",
  ]);
});

test("main: đạt → 0; tụt → 1; thiếu summary → 1; baseline hỏng/tham số lạ → 2", () => {
  const root = fixture({ "apps/x": { lines: 80, branches: 70 } }, { "apps/x": { lines: 80, branches: 70 } });
  try {
    let q = quiet();
    assert.equal(main(["--root", root], q.log), 0);
    assert.match(q.out.log.at(-1), /xanh/);

    writeFileSync(join(root, "apps/x/coverage/coverage-summary.json"), summary(80, 69.99));
    q = quiet();
    assert.equal(main(["--root", root], q.log), 1);
    assert.match(q.out.error.join("\n"), /branches 69\.99 % < baseline 70 %/);

    rmSync(join(root, "apps/x/coverage"), { recursive: true });
    q = quiet();
    assert.equal(main(["--root", root], q.log), 1);

    writeFileSync(join(root, "coverage-baseline.json"), "{}");
    assert.equal(main(["--root", root], quiet().log), 2);
    assert.equal(main(["--bogus"], quiet().log), 2);
    assert.equal(main(["--against"], quiet().log), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main --update: nâng baseline khi đo cao hơn, không hạ; còn tụt thì không ghi và exit 1", () => {
  const root = fixture({ "apps/x": { lines: 80, branches: 70 } }, { "apps/x": { lines: 85, branches: 70 } });
  const file = join(root, "coverage-baseline.json");
  try {
    assert.equal(main(["--root", root, "--update"], quiet().log), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, {
      "apps/x": { lines: 85, branches: 70 },
    });

    writeFileSync(join(root, "apps/x/coverage/coverage-summary.json"), summary(90, 60));
    const before = readFileSync(file, "utf8");
    assert.equal(main(["--root", root, "--update"], quiet().log), 1);
    assert.equal(readFileSync(file, "utf8"), before, "không ghi khi còn chỉ số dưới baseline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main --against: PR hạ baseline đã commit → 1; ref chưa có file → bỏ qua; ref sai → 2", () => {
  const root = fixture({ "apps/x": { lines: 80, branches: 70 } }, { "apps/x": { lines: 80, branches: 60 } });
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-q");
    git(
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "rỗng",
    );
    git("tag", "empty");
    git("add", "coverage-baseline.json");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "baseline");
    // Hạ baseline cho khớp số đo đã tụt — chính hành vi ratchet phải chặn.
    writeFileSync(
      join(root, "coverage-baseline.json"),
      JSON.stringify(base({ "apps/x": { lines: 80, branches: 60 } })),
    );
    let q = quiet();
    assert.equal(main(["--root", root, "--against", "HEAD"], q.log), 1);
    assert.match(q.out.error.join("\n"), /baseline branches bị hạ 70 % → 60 %/);

    q = quiet();
    assert.equal(main(["--root", root, "--against", "empty"], q.log), 0);
    assert.match(q.out.log.join("\n"), /chưa có coverage-baseline\.json/);

    assert.equal(main(["--root", root, "--against", "no-such-ref"], quiet().log), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baselineAtRef: lỗi git khác 'không có file' được ném ra (không coi là bỏ qua)", () => {
  const boom = () => {
    const e = new Error("x");
    e.stderr = "fatal: not a git repository";
    throw e;
  };
  assert.throws(() => baselineAtRef(".", "HEAD", "coverage-baseline.json", boom), /not a git repository/);
  const absent = () => {
    const e = new Error("x");
    e.stderr = "fatal: path 'coverage-baseline.json' does not exist in 'HEAD'";
    throw e;
  };
  assert.equal(baselineAtRef(".", "HEAD", "coverage-baseline.json", absent), null);
});
