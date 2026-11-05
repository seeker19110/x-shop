// Test scripts/coverage-merge.mjs (T-198): `node --test scripts/coverage-merge.test.mjs`. Không cần Postgres/Redis; phần
// gộp thật dùng istanbul-lib-* qua jest của apps/backend (cần `pnpm install`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  alignCoverages,
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

test("mergeCoverage: nhánh vắng ở một shard KHÔNG mượn hit của block chứa ở shard khác (phủ ảo, T-241/D-165)", () => {
  const libs = istanbulLibs(root);
  const L = (a, b, c, d) => ({ start: { line: a, column: b }, end: { line: c, column: d } });
  const block = { type: "block", loc: L(1, 0, 10, 1), locations: [L(1, 0, 10, 1)], line: 1 };
  const fn = (hits) => ({
    fnMap: { 0: { name: "m", decl: L(3, 2, 3, 3), loc: L(3, 2, 6, 3), line: 3 } },
    f: { 0: hits },
  });
  const inner = { type: "branch", loc: L(4, 4, 4, 30), locations: [L(4, 4, 4, 30)], line: 4 };
  const file = (fnHits, withInner, innerHits) => ({
    "/c.ts": {
      path: "/c.ts",
      statementMap: { 0: L(1, 0, 10, 1) },
      s: { 0: 6 },
      ...fn(fnHits),
      branchMap: withInner ? { 0: block, 1: inner } : { 0: block },
      b: withInner ? { 0: [6], 1: [innerHits] } : { 0: [6] },
    },
  });
  // Shard A nạp module (thân class 6 lần) nhưng KHÔNG gọi hàm m (v8: range hàm đếm 0, không ghi nhánh bên trong).
  // Shard B gọi m 2 lần, nhánh L4 trong m chưa chạy.
  const a = file(0, false);
  const b = file(2, true, 0);
  // Đối chứng: gộp thẳng bằng istanbul thì nhánh L4 thành "đã phủ" (mượn hit 6 của block thân class ở shard A).
  // (istanbul giữ tham chiếu object đầu vào và ghi đè khi gộp → gộp thô trên bản sao.)
  const raw = libs.coverage.createCoverageMap({});
  raw.merge(structuredClone(a));
  raw.merge(structuredClone(b));
  assert.equal(raw.getCoverageSummary().toJSON().branches.covered, 2);
  for (const order of [
    [a, b],
    [b, a],
  ]) {
    const s = mergeCoverage(libs, order).getCoverageSummary().toJSON();
    assert.equal(s.branches.total, 2);
    assert.equal(s.branches.covered, 1, "nhánh L4 chưa chạy ở shard nào → không phủ");
  }
  // Ngữ nghĩa v8 được giữ: block chạy cùng số lần với cha thì v8 không ghi riêng → shard A gọi m 2 lần mà không ghi
  // L4 nghĩa là L4 chạy 2 lần (range chứa hẹp nhất trong CÙNG shard là hàm m).
  assert.equal(
    mergeCoverage(libs, [file(2, false), b])
      .getCoverageSummary()
      .toJSON().branches.covered,
    2,
  );
  // Có chạy thật ở shard có ghi thì vẫn được tính.
  assert.equal(
    mergeCoverage(libs, [a, file(2, true, 3)])
      .getCoverageSummary()
      .toJSON().branches.covered,
    2,
  );
});

test("mergeCoverage: placeholder `all: true` (file shard không nạp) không thêm mục vào số đo (review T-241)", () => {
  const libs = istanbulLibs(root);
  const L = (a, b, c, d) => ({ start: { line: a, column: b }, end: { line: c, column: d } });
  const real = {
    "/g.ts": {
      path: "/g.ts",
      statementMap: { 0: L(1, 0, 5, 1) },
      s: { 0: 1 },
      fnMap: { 0: { name: "grant", decl: L(1, 0, 1, 5), loc: L(1, 0, 5, 1), line: 1 } },
      f: { 0: 1 },
      branchMap: { 0: { type: "if", loc: L(2, 2, 2, 9), locations: [L(2, 2, 2, 9)], line: 2 } },
      b: { 0: [1] },
    },
  };
  const empty = {
    "/g.ts": {
      path: "/g.ts",
      all: true,
      statementMap: { 0: L(1, 0, 5, 1) },
      s: { 0: 0 },
      fnMap: { 0: { name: "(empty-report)", decl: L(1, 0, 5, 1), loc: L(1, 0, 5, 1), line: 1 } },
      f: { 0: 0 },
      branchMap: { 0: { type: "branch", loc: L(1, 0, 5, 1), locations: [L(1, 0, 5, 1)], line: 1 } },
      b: { 0: [0] },
    },
  };
  const want = mergeCoverage(libs, [real]).getCoverageSummary().toJSON();
  for (const order of [
    [empty, real],
    [real, empty],
  ]) {
    const m = mergeCoverage(libs, order);
    assert.deepEqual(m.getCoverageSummary().toJSON(), want);
    assert.ok(!Object.values(m.fileCoverageFor("/g.ts").data.fnMap).some((f) => f.name === "(empty-report)"));
  }
});

test("mergeCoverage: nhánh trong callback vô danh không chạy (dòng = 0) không mượn hit của hàm bao ngoài", () => {
  const libs = istanbulLibs(root);
  const L = (a, b, c, d) => ({ start: { line: a, column: b }, end: { line: c, column: d } });
  const fn = { name: "step", decl: L(1, 0, 1, 4), loc: L(1, 0, 10, 1), line: 1 };
  const elseBr = { type: "branch", loc: L(7, 3, 9, 3), locations: [L(7, 3, 9, 3)], line: 7 };
  // Dòng 1–4 (thân step) và 5–9 (callback vô danh bên trong).
  const statementMap = { 0: L(2, 2, 2, 20), 1: L(6, 4, 6, 20), 2: L(8, 4, 8, 20) };
  // Shard S: step chạy 3 lần nhưng callback không chạy → v8 không ghi callback, chỉ để dòng 6/8 = 0.
  const s = {
    "/r.ts": {
      path: "/r.ts",
      statementMap,
      s: { 0: 3, 1: 0, 2: 0 },
      fnMap: { 0: fn },
      f: { 0: 3 },
      branchMap: {},
      b: {},
    },
  };
  // Shard A: callback chạy, nhánh else chưa chạy.
  const a = {
    "/r.ts": {
      path: "/r.ts",
      statementMap,
      s: { 0: 1, 1: 2, 2: 0 },
      fnMap: { 0: fn },
      f: { 0: 1 },
      branchMap: { 0: elseBr },
      b: { 0: [0] },
    },
  };
  for (const order of [
    [s, a],
    [a, s],
  ])
    assert.equal(mergeCoverage(libs, order).getCoverageSummary().toJSON().branches.covered, 0);
  // Đối chứng: dòng trong nhánh có chạy ở S (block cùng số lần với cha, v8 không ghi riêng) → vẫn tính theo hàm bao.
  const s2 = structuredClone(s);
  s2["/r.ts"].s[2] = 3;
  assert.equal(mergeCoverage(libs, [s2, a]).getCoverageSummary().toJSON().branches.covered, 1);
});

test("mergeCoverage: range hẹp nhất trùng loc lấy số nhỏ nhất; range ngoài đếm 0 không che range trong đã chạy", () => {
  const libs = istanbulLibs(root);
  const L = (a, b, c, d) => ({ start: { line: a, column: b }, end: { line: c, column: d } });
  const body = L(1, 0, 20, 1);
  const br = (loc, line) => ({ type: "branch", loc, locations: [loc], line });
  const target = br(L(4, 4, 4, 20), 4);
  const stmts = { statementMap: { 0: L(4, 4, 4, 20) }, s: { 0: 1 } };
  // Shard có ghi nhánh mục tiêu (chưa chạy) — để tạo mục vắng ở shard kia.
  const other = {
    "/k.ts": { path: "/k.ts", ...stmts, fnMap: {}, f: {}, branchMap: { 0: target }, b: { 0: [0] } },
  };
  // (a) Hai range cùng loc thân class (static initializer 0, instance initializer 5): lấy min → 0.
  const same = {
    "/k.ts": {
      path: "/k.ts",
      statementMap: {},
      s: {},
      fnMap: {
        0: { name: "<static_initializer>", decl: body, loc: body, line: 1 },
        1: { name: "<instance_members_initializer>", decl: body, loc: body, line: 1 },
      },
      f: { 0: 0, 1: 5 },
      branchMap: {},
      b: {},
    },
  };
  for (const order of [
    [same, other],
    [other, same],
  ])
    assert.equal(mergeCoverage(libs, order).getCoverageSummary().toJSON().branches.covered, 0);
  // (b) Range ngoài đếm 0 bao một static method đã gọi 2 lần chứa mục: lấy range HẸP NHẤT (2), không min mọi range chứa.
  const nested = {
    "/k.ts": {
      path: "/k.ts",
      ...stmts,
      fnMap: {
        0: { name: "<instance_members_initializer>", decl: body, loc: body, line: 1 },
        1: { name: "make", decl: L(3, 2, 3, 6), loc: L(3, 2, 6, 3), line: 3 },
      },
      f: { 0: 0, 1: 2 },
      branchMap: {},
      b: {},
    },
  };
  assert.equal(mergeCoverage(libs, [nested, other]).getCoverageSummary().toJSON().branches.covered, 1);
});

test("alignCoverages: bù statement/hàm/nhánh vắng bằng 0 (cả bT), không đổi đầu vào, giữ mục đã có", () => {
  const a = { "/a.ts": fileCov("/a.ts", [1, 0, 0, 0], [1, 0], 1) };
  const b = { "/a.ts": fileCov("/a.ts", [0, 0, 0, 0], [0, 0], 0) };
  delete b["/a.ts"].fnMap[0];
  delete b["/a.ts"].f[0];
  delete b["/a.ts"].branchMap[0];
  delete b["/a.ts"].b[0];
  b["/a.ts"].bT = {};
  const before = structuredClone(b);
  const [a2, b2] = alignCoverages([a, b]);
  assert.deepEqual(b, before, "không sửa object đầu vào");
  assert.deepEqual(a2, a, "shard đã đủ mục giữ nguyên");
  assert.equal(Object.keys(b2["/a.ts"].fnMap).length, 1);
  assert.equal(b2["/a.ts"].f[0], 0);
  assert.deepEqual(b2["/a.ts"].b[0], [0, 0]);
  assert.deepEqual(b2["/a.ts"].bT[0], [0, 0]);
  // File chỉ có ở một shard: không thêm vào shard kia.
  const [, c2] = alignCoverages([a, { "/z.ts": fileCov("/z.ts", [1, 1, 1, 1], [1, 1], 1) }]);
  assert.deepEqual(Object.keys(c2), ["/z.ts"]);
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
