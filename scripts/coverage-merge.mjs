#!/usr/bin/env node
// Gộp coverage tích hợp chia shard (T-198, QA-COV-001) cho job `integration-coverage-merge` của CI. Mỗi thư mục shard
// (artifact của một job matrix) có `coverage-final.json` (reporter `json` của jest, provider v8 → dạng istanbul) và
// `shard.json` {shard, total, ids}. Kiểm đủ bộ trước khi gộp — thiếu/thừa/trùng shard, id trùng giữa shard, hoặc hợp các
// id lệch danh sách mong đợi (`--expect-ids`, vd `list.mjs` không tham số lọc `http:`) → exit 2: không đo đủ ≠ đạt.
// Trước khi gộp, bù mục vắng ở từng shard theo chính shard đó (alignCoverages, T-241 — tránh phủ ảo của istanbul).
// Gộp bằng istanbul-lib-coverage (cộng số lần chạy theo vị trí) rồi in báo cáo bằng istanbul-lib-report/istanbul-reports
// — ĐÚNG các thư viện jest dùng để ra coverage-summary.json, lấy qua chuỗi phụ thuộc của `jest` trong apps/backend (không
// thêm phụ thuộc). Ra `<out>/coverage-summary.json` (cho `coverage-ratchet.mjs --suite integration`), coverage-final.json,
// lcov.info. Không so ngưỡng — việc đó của coverage-ratchet.mjs.
// CLI: node scripts/coverage-merge.mjs --out <dir> [--expect-ids <file>] [--root <repo>] <thư mục shard>...
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPORTERS = ["json", "json-summary", "lcovonly", "text-summary"];

/** Kiểm nội dung shard.json; trả {shard, total, ids}. Sai → ném lỗi nêu chỗ sai. */
export function parseShardMeta(text, label = "shard.json") {
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: JSON không hợp lệ (${e.message})`);
  }
  const { shard, total, ids } = d ?? {};
  if (!Number.isInteger(total) || total < 1) throw new Error(`${label}: total phải là số nguyên ≥ 1`);
  if (!Number.isInteger(shard) || shard < 1 || shard > total)
    throw new Error(`${label}: shard phải là số nguyên 1–${total}`);
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string" || x === ""))
    throw new Error(`${label}: ids phải là mảng chuỗi không rỗng`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label}: ids có phần tử trùng`);
  return { shard, total, ids };
}

/**
 * Kiểm bộ shard đủ và rời nhau. `metas`: [{shard,total,ids,label}]. `expected`: mảng id mong đợi hoặc null.
 * Trả danh sách lỗi (rỗng = đạt).
 */
export function checkShardSet(metas, expected = null) {
  const errors = [];
  if (metas.length === 0) return ["không có shard nào"];
  const totals = new Set(metas.map((m) => m.total));
  if (totals.size !== 1) errors.push(`các shard khai total khác nhau: ${[...totals].join(", ")}`);
  const total = metas[0].total;
  const seen = new Map();
  for (const m of metas) {
    if (seen.has(m.shard))
      errors.push(`shard ${m.shard} xuất hiện hai lần (${seen.get(m.shard)}, ${m.label})`);
    else seen.set(m.shard, m.label);
  }
  for (let k = 1; k <= total; k++) if (!seen.has(k)) errors.push(`thiếu shard ${k}/${total}`);
  const owner = new Map();
  for (const m of metas) {
    for (const id of m.ids) {
      if (owner.has(id)) errors.push(`id ${id} chạy ở cả shard ${owner.get(id)} và ${m.shard}`);
      else owner.set(id, m.shard);
    }
  }
  if (expected) {
    const want = new Set(expected);
    for (const id of want) if (!owner.has(id)) errors.push(`id ${id} không chạy ở shard nào`);
    for (const id of owner.keys())
      if (!want.has(id)) errors.push(`id ${id} không có trong danh sách mong đợi`);
  }
  return errors;
}

/** Kiểm nội dung coverage-final.json: object không rỗng, mỗi mục có s/statementMap. Trả object. */
export function parseCoverage(text, label = "coverage-final.json") {
  let d;
  try {
    d = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: JSON không hợp lệ (${e.message})`);
  }
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).length === 0)
    throw new Error(`${label}: cần object không rỗng (file → coverage istanbul)`);
  for (const [file, fc] of Object.entries(d)) {
    if (!fc || typeof fc !== "object" || !fc.statementMap || !fc.s)
      throw new Error(`${label}: mục ${file} không phải coverage istanbul (thiếu statementMap/s)`);
  }
  return d;
}

/** Thư viện istanbul mà jest của apps/backend dùng (jest → @jest/core → @jest/reporters). Không tìm được → ném lỗi. */
export function istanbulLibs(root) {
  let req = createRequire(join(root, "apps/backend/package.json"));
  try {
    for (const pkg of ["jest", "@jest/core", "@jest/reporters"])
      req = createRequire(req.resolve(`${pkg}/package.json`));
    return {
      coverage: req("istanbul-lib-coverage"),
      report: req("istanbul-lib-report"),
      reports: req("istanbul-reports"),
    };
  } catch (e) {
    throw new Error(
      `không nạp được istanbul-lib-* qua jest của apps/backend (đã \`pnpm install\`?): ${e.message.split("\n")[0]}`,
    );
  }
}

const locKey = (l) => `${l.start.line}|${l.start.column}|${l.end.line}|${l.end.column}`;
const before = (a, b) => a.line < b.line || (a.line === b.line && a.column <= b.column);
/** `outer` chứa `inner` (cho phép trùng biên). */
const contains = (outer, inner) => before(outer.start, inner.start) && before(inner.end, outer.end);
// Khoá trùng cách istanbul-lib-coverage 3.x so vị trí khi gộp (keyFromLoc): statement theo loc, hàm theo loc, nhánh theo
// locations[0].
const KINDS = [
  { map: "statementMap", hits: "s", key: (it) => locKey(it), loc: (it) => it },
  { map: "fnMap", hits: "f", key: (it) => locKey(it.loc), loc: (it) => it.loc },
  { map: "branchMap", hits: "b", key: (it) => locKey(it.locations[0]), loc: (it) => it.locations[0] },
];

/** Range có số lần chạy của MỘT shard (block v8 trong branchMap + thân hàm trong fnMap) — để tìm range chứa. */
function shardRanges(fc) {
  const out = [];
  for (const [k, it] of Object.entries(fc.branchMap ?? {}))
    (it.locations ?? []).forEach((loc, i) => out.push({ loc, hits: fc.b?.[k]?.[i] ?? 0 }));
  for (const [k, it] of Object.entries(fc.fnMap ?? {}))
    if (it.loc) out.push({ loc: it.loc, hits: fc.f?.[k] ?? 0 });
  return out;
}

/**
 * Số lần chạy của mục vắng ở một shard, suy từ CHÍNH shard đó:
 * - range chứa hẹp nhất (block ở branchMap, thân hàm ở fnMap; nhiều range hẹp nhất ngang nhau/chéo nhau → lấy số nhỏ
 *   nhất cho tất định); không có range chứa → 0;
 * - nhưng nếu mọi statement nằm trọn trong mục đều 0 lần ở shard này thì mục = 0: hàm VÔ DANH không được gọi (callback,
 *   executor Promise) v8 không ghi vào branchMap/fnMap, chỉ để lại dòng 0 — range chứa ghi được lại là hàm bao ngoài đã
 *   chạy (review T-241). Cũng phủ range v8 gộp liền kề ở shard khác (vd then-block + phần sau `throw` cùng đếm 0).
 *   Quy tắc thiên về an toàn: ở mức một shard có thể đặt 0 cả khi phần đầu mục đã chạy (dòng 0 nằm trong range 0 lồng bên
 *   trong) — chấp nhận, vì đếm thiếu không tạo phủ giả và shard khác chạy thật vẫn phủ được.
 */
function missingHits(ranges, stmts, loc) {
  const cands = ranges.filter((r) => contains(r.loc, loc));
  if (cands.length === 0) return 0;
  const narrowest = cands.filter(
    (r) => !cands.some((o) => o !== r && contains(r.loc, o.loc) && !contains(o.loc, r.loc)),
  );
  const hits = Math.min(...narrowest.map((r) => r.hits));
  if (hits === 0) return 0;
  const inside = stmts.filter((st) => contains(loc, st.loc));
  return inside.length > 0 && inside.every((st) => st.hits === 0) ? 0 : hits;
}

/**
 * Bù cho mỗi shard các statement/hàm/nhánh mà shard khác có nhưng shard này không có (T-241, D-165…D-167), số lần chạy
 * theo `missingHits` (suy từ chính shard đó). Vì sao: `CoverageMap.merge` của istanbul gặp mục vắng thì cộng hit của
 * range chứa nhưng chỉ tìm trong CÙNG LOẠI map — nhánh tìm trong branchMap, bỏ qua thân hàm ở fnMap — nên nhánh trong
 * hàm mà shard không gọi (fnMap đếm 0) mượn hit của block thân class thành "đã phủ" (phủ ảo), số ảo đổi theo cách chia
 * shard. Bù trước thì mọi mục có khoá khớp ở mọi shard → istanbul chỉ cộng đúng vị trí.
 * Mục `all: true` (placeholder jest sinh cho file shard không nạp, `collectCoverageFrom`) bỏ qua như istanbul vẫn làm:
 * không đưa vào tập hợp, không bù. Không sửa object đầu vào.
 */
export function alignCoverages(coverages) {
  const union = new Map(); // file → {statementMap: Map(key→item), ...}
  for (const c of coverages) {
    for (const [file, fc] of Object.entries(c)) {
      if (fc.all === true) continue;
      let u = union.get(file);
      if (!u) union.set(file, (u = Object.fromEntries(KINDS.map((k) => [k.map, new Map()]))));
      for (const k of KINDS)
        for (const it of Object.values(fc[k.map] ?? {})) {
          const key = k.key(it);
          if (!u[k.map].has(key)) u[k.map].set(key, it);
        }
    }
  }
  return coverages.map((c) =>
    Object.fromEntries(
      Object.entries(c).map(([file, fc]) => {
        if (fc.all === true || !union.has(file)) return [file, fc];
        const out = { ...fc };
        const ranges = shardRanges(fc);
        const stmts = Object.entries(fc.statementMap ?? {}).map(([k, loc]) => ({
          loc,
          hits: fc.s?.[k] ?? 0,
        }));
        for (const k of KINDS) {
          const map = { ...(fc[k.map] ?? {}) };
          const hits = { ...(fc[k.hits] ?? {}) };
          const bT = k.hits === "b" && fc.bT ? { ...fc.bT } : null;
          const have = new Set(Object.values(map).map(k.key));
          let next = Math.max(-1, ...Object.keys(map).map(Number).filter(Number.isInteger)) + 1;
          for (const [key, it] of union.get(file)[k.map]) {
            if (have.has(key)) continue;
            map[next] = it;
            if (k.hits === "b") {
              hits[next] = it.locations.map((loc) => missingHits(ranges, stmts, loc));
              if (bT) bT[next] = it.locations.map(() => 0);
            } else hits[next] = missingHits(ranges, stmts, k.loc(it));
            next++;
          }
          out[k.map] = map;
          out[k.hits] = hits;
          if (bT) out.bT = bT;
        }
        return [file, out];
      }),
    ),
  );
}

/** Gộp các object coverage-final.json (đã bù mục vắng — alignCoverages); trả CoverageMap. */
export function mergeCoverage(libs, coverages) {
  const map = libs.coverage.createCoverageMap({});
  for (const c of alignCoverages(coverages)) map.merge(c);
  return map;
}

/** Ghi báo cáo REPORTERS của `map` vào `dir`; trả tỉ lệ tổng {lines, branches, statements, functions}. */
export function writeReports(libs, map, dir) {
  mkdirSync(dir, { recursive: true });
  const context = libs.report.createContext({ dir, coverageMap: map });
  for (const r of REPORTERS) libs.reports.create(r).execute(context);
  const s = map.getCoverageSummary().toJSON();
  return Object.fromEntries(["lines", "branches", "statements", "functions"].map((k) => [k, s[k].pct]));
}

function parseArgs(argv) {
  const opts = { out: null, expectIds: null, root: fileURLToPath(new URL("..", import.meta.url)), dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "--expect-ids" || a === "--root") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} cần giá trị`);
      if (a === "--out") opts.out = v;
      else if (a === "--root") opts.root = v;
      else opts.expectIds = v;
    } else if (a.startsWith("--")) throw new Error(`tham số lạ: ${a}`);
    else opts.dirs.push(a);
  }
  if (!opts.out) throw new Error("thiếu --out <dir>");
  if (opts.dirs.length === 0) throw new Error("thiếu thư mục shard");
  return opts;
}

export function main(argv = process.argv.slice(2), log = console) {
  try {
    const opts = parseArgs(argv);
    const metas = [];
    const coverages = [];
    for (const dir of opts.dirs) {
      const read = (f) => {
        try {
          return readFileSync(join(dir, f), "utf8");
        } catch {
          throw new Error(`${join(dir, f)}: không đọc được (artifact shard thiếu file)`);
        }
      };
      metas.push({ ...parseShardMeta(read("shard.json"), join(dir, "shard.json")), label: dir });
      coverages.push(parseCoverage(read("coverage-final.json"), join(dir, "coverage-final.json")));
    }
    let expected = null;
    if (opts.expectIds) {
      expected = readFileSync(opts.expectIds, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (expected.length === 0) throw new Error(`${opts.expectIds}: danh sách id mong đợi rỗng`);
    }
    const errors = checkShardSet(metas, expected);
    if (errors.length) {
      for (const e of errors) log.error(`✗ ${e}`);
      log.error("coverage-merge: bộ shard không đủ/không rời nhau — không gộp (đo thiếu ≠ đạt)");
      return 2;
    }
    const libs = istanbulLibs(resolve(opts.root));
    const pct = writeReports(libs, mergeCoverage(libs, coverages), resolve(opts.out));
    log.log(
      `coverage-merge: gộp ${metas.length} shard (${metas.reduce((n, m) => n + m.ids.length, 0)} suite) → ${opts.out}: ` +
        `lines ${pct.lines} %, branches ${pct.branches} %, statements ${pct.statements} %, functions ${pct.functions} %`,
    );
    return 0;
  } catch (e) {
    log.error(`coverage-merge: ${e.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
