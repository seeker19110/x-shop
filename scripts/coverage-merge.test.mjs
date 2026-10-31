// Test scripts/coverage-merge.mjs (T-198): `node --test scripts/coverage-merge.test.mjs`. Không cần Postgres/Redis; phần
// gộp thật dùng istanbul-lib-* qua jest của apps/backend (cần `pnpm install`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkShardSet,
  istanbulLibs,
  main,
  mergeCoverage,
  parseCoverage,
  parseShardMeta,
} from "./coverage-merge.mjs";
import { parseSummary } from "./coverage-ratchet.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Coverage istanbul tối thiểu của một file: 4 dòng (mỗi dòng một statement), 1 nhánh 2 đường, 1 hàm. */
function fileCov(path, s, b, f) {
  const loc = (line) => ({ start: { line, column: 0 }, end: { line, column: 10 } });
  return {
    path,
    statementMap: Object.fromEntries([1, 2, 3, 4].map((l, i) => [String(i), loc(l)])),
    s: Object.fromEntries(s.map((v, i) => [String(i), v])),
    fnMap: { 0: { name: "f", decl: loc(1), loc: loc(1), line: 1 } },
    f: { 0: f },
    branchMap: { 0: { type: "if", loc: loc(2), locations: [loc(2), loc(3)], line: 2 } },
    b: { 0: b },
  };
}

function quiet() {
  const out = { log: [], error: [] };
  return { out, log: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) } };
}

test("parseShardMeta: đúng dạng; sai shard/total/ids → ném lỗi", () => {
  assert.deepEqual(parseShardMeta('{"shard":2,"total":3,"ids":["http:a"]}'), {
    shard: 2,
    total: 3,
    ids: ["http:a"],
  });
  for (const bad of [
    "{",
    "null",
    '{"shard":0,"total":3,"ids":["a"]}',
    '{"shard":4,"total":3,"ids":["a"]}',
    '{"shard":1.5,"total":3,"ids":["a"]}',
    '{"shard":1,"total":0,"ids":["a"]}',
    '{"shard":1,"total":"3","ids":["a"]}',
    '{"shard":1,"total":3,"ids":[]}',
    '{"shard":1,"total":3,"ids":[""]}',
    '{"shard":1,"total":3,"ids":["a","a"]}',
    '{"shard":1,"total":3}',
  ]) {
    assert.throws(() => parseShardMeta(bad), Error, bad);
  }
});

test("checkShardSet: đủ & rời nhau → rỗng; thiếu/trùng shard, total lệch, id trùng/thiếu/thừa → lỗi", () => {
  const m = (shard, total, ids) => ({ shard, total, ids, label: `d${shard}` });
  assert.deepEqual(checkShardSet([m(1, 2, ["a"]), m(2, 2, ["b"])], ["a", "b"]), []);
  assert.deepEqual(checkShardSet([m(1, 2, ["a"]), m(2, 2, ["b"])]), [], "không --expect-ids");
  assert.deepEqual(checkShardSet([]), ["không có shard nào"]);
  assert.match(checkShardSet([m(1, 2, ["a"])]).join("|"), /thiếu shard 2\/2/);
  assert.match(checkShardSet([m(1, 2, ["a"]), m(1, 2, ["b"])]).join("|"), /shard 1 xuất hiện hai lần/);
  assert.match(checkShardSet([m(1, 2, ["a"]), m(2, 3, ["b"])]).join("|"), /total khác nhau/);
  assert.match(checkShardSet([m(1, 2, ["a"]), m(2, 2, ["a"])]).join("|"), /id a chạy ở cả shard 1 và 2/);
  assert.match(
    checkShardSet([m(1, 2, ["a"]), m(2, 2, ["b"])], ["a", "b", "c"]).join("|"),
    /id c không chạy ở shard nào/,
  );
  assert.match(
    checkShardSet([m(1, 2, ["a"]), m(2, 2, ["b", "x"])], ["a", "b"]).join("|"),
    /id x không có trong danh sách mong đợi/,
  );
});

test("parseCoverage: object coverage istanbul không rỗng; sai → ném lỗi", () => {
  const ok = { "/a.ts": fileCov("/a.ts", [1, 0, 0, 0], [0, 0], 0) };
  assert.deepEqual(parseCoverage(JSON.stringify(ok)), ok);
  for (const bad of ["x", "[]", "{}", "null", '{"/a.ts":{}}', '{"/a.ts":{"s":{}}}']) {
    assert.throws(() => parseCoverage(bad), Error, bad);
  }
});

test("mergeCoverage (istanbul của jest): cộng số lần chạy theo vị trí — hợp dòng/nhánh của hai shard", () => {
  const libs = istanbulLibs(root);
  const a = {
    "/a.ts": fileCov("/a.ts", [1, 1, 0, 0], [1, 0], 1),
    "/b.ts": fileCov("/b.ts", [0, 0, 0, 0], [0, 0], 0),
  };
  const b = {
    "/a.ts": fileCov("/a.ts", [1, 0, 1, 0], [0, 2], 1),
    "/b.ts": fileCov("/b.ts", [3, 0, 0, 0], [0, 0], 1),
  };
  const s = mergeCoverage(libs, [a, b]).getCoverageSummary().toJSON();
  // a.ts: dòng 1,2,3 có chạy; b.ts: dòng 1 → 4/8. Nhánh: a.ts cả 2 đường → 2/4.
  assert.equal(s.lines.covered, 4);
  assert.equal(s.lines.total, 8);
  assert.equal(s.branches.covered, 2);
  assert.equal(s.branches.total, 4);
  assert.equal(s.functions.covered, 2);
  // Gộp thứ tự ngược cho cùng kết quả (job gộp không phụ thuộc thứ tự tải artifact).
  assert.deepEqual(mergeCoverage(libs, [b, a]).getCoverageSummary().toJSON(), s);
});

test("main: gộp thư mục shard → coverage-summary.json đọc được bởi coverage-ratchet; bộ shard thiếu → exit 2, không ghi", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xs-cov-merge-"));
  try {
    const shard = (k, ids, cov) => {
      const d = join(tmp, `coverage-integration-${k}`);
      mkdirSync(d);
      writeFileSync(join(d, "shard.json"), JSON.stringify({ shard: k, total: 2, ids }));
      writeFileSync(join(d, "coverage-final.json"), JSON.stringify(cov));
      return d;
    };
    const d1 = shard(1, ["http:a"], { "/a.ts": fileCov("/a.ts", [1, 1, 0, 0], [1, 0], 1) });
    const d2 = shard(2, ["http:b"], { "/a.ts": fileCov("/a.ts", [0, 0, 1, 1], [0, 1], 0) });
    const ids = join(tmp, "ids.txt");
    writeFileSync(ids, "http:a\nhttp:b\n");
    const out = join(tmp, "out");

    const missing = quiet();
    assert.equal(main(["--out", out, "--expect-ids", ids, "--root", root, d1], missing.log), 2);
    assert.match(missing.out.error.join("\n"), /thiếu shard 2\/2/);
    assert.throws(() => readFileSync(join(out, "coverage-summary.json")), "không ghi khi bộ shard thiếu");

    const extra = join(tmp, "ids3.txt");
    writeFileSync(extra, "http:a\nhttp:b\nhttp:c\n");
    assert.equal(main(["--out", out, "--expect-ids", extra, "--root", root, d1, d2], quiet().log), 2);

    const q = quiet();
    assert.equal(
      main(["--out", out, "--expect-ids", ids, "--root", root, d1, d2], q.log),
      0,
      q.out.error.join("\n"),
    );
    const pct = parseSummary(readFileSync(join(out, "coverage-summary.json"), "utf8"));
    assert.deepEqual(pct, { lines: 100, branches: 100 });
    assert.ok(JSON.parse(readFileSync(join(out, "coverage-final.json"), "utf8"))["/a.ts"]);
    assert.match(readFileSync(join(out, "lcov.info"), "utf8"), /^SF:.*a\.ts$/m);

    // Artifact thiếu coverage-final.json → exit 2.
    rmSync(join(d2, "coverage-final.json"));
    const broken = quiet();
    assert.equal(main(["--out", out, "--root", root, d1, d2], broken.log), 2);
    assert.match(broken.out.error.join("\n"), /coverage-final\.json: không đọc được/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("main: tham số sai → exit 2", () => {
  for (const args of [[], ["--out"], ["--out", "x"], ["--bogus", "x", "d"], ["--out", "--root", "d"]]) {
    assert.equal(main(args, quiet().log), 2, JSON.stringify(args));
  }
});

test("istanbulLibs: không có apps/backend/node_modules → lỗi rõ ràng", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xs-cov-merge-nolib-"));
  try {
    assert.throws(() => istanbulLibs(tmp), /không nạp được istanbul-lib-\*/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
