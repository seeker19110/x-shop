// Test hàm thuần của explain-hot-paths.mjs / hot-paths.mjs / perf-dataset.mjs (T-074): node --test scripts/ops/explain-hot-paths.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderSummary,
  seqScans,
  toPgPlaceholders,
  tooSmall,
  validateHotPaths,
  violations,
} from "./explain-hot-paths.mjs";
import { hotPaths, LARGE_TABLES, loadCatalogQuery } from "./hot-paths.mjs";
import { assertSafePerfTargets, orderHistoryStatements, recentTail } from "./perf-dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("toPgPlaceholders: đánh số theo thứ tự, bỏ qua ? trong chuỗi/định danh/chú thích", () => {
  assert.equal(toPgPlaceholders("SELECT ? , ?", 2), "SELECT $1 , $2");
  assert.equal(
    toPgPlaceholders(`SELECT '?' AS "a?b", 'it''s ?' -- có ? ở đây\n FROM t WHERE x = ?`, 1),
    `SELECT '?' AS "a?b", 'it''s ?' -- có ? ở đây\n FROM t WHERE x = $1`,
  );
  assert.equal(toPgPlaceholders("SELECT 1", 0), "SELECT 1");
  assert.equal(toPgPlaceholders("", 0), "");
});

test("toPgPlaceholders: lệch số tham số, ??, chuỗi không đóng → lỗi", () => {
  assert.throws(() => toPgPlaceholders("SELECT ?", 0), /số placeholder \(1\) khác số tham số \(0\)/);
  assert.throws(() => toPgPlaceholders("SELECT 1", 1), /khác số tham số/);
  assert.throws(() => toPgPlaceholders("SELECT ??", 1), /`\?\?`/);
  assert.throws(() => toPgPlaceholders("SELECT 'abc", 0), /không đóng/);
});

const plan = (node) => [{ Plan: node, "Execution Time": 1 }];

test("seqScans: tìm Seq Scan lồng (InitPlan/SubPlan/CTE), bỏ qua Index/Bitmap/CTE Scan", () => {
  const p = plan({
    "Node Type": "Limit",
    Plans: [
      { "Node Type": "Seq Scan", "Relation Name": "sales_channel", "Parent Relationship": "InitPlan" },
      {
        "Node Type": "Hash Join",
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "catalog_variant_index", "Parallel Aware": true },
          { "Node Type": "Index Scan", "Relation Name": "order_finance" },
          {
            "Node Type": "Bitmap Heap Scan",
            "Relation Name": "outbox_event",
            Plans: [{ "Node Type": "Bitmap Index Scan" }],
          },
          { "Node Type": "CTE Scan", "CTE Name": "v" },
        ],
      },
    ],
  });
  assert.deepEqual(seqScans(p), ["sales_channel", "catalog_variant_index"]);
  assert.deepEqual(seqScans(plan({ "Node Type": "Result" })), []);
  assert.deepEqual(seqScans([]), []);
});

test("violations: chỉ bảng lớn, trừ bảng được phép, không lặp", () => {
  const entry = { name: "x", allowSeqScan: { catalog_variant_index: "lý do đủ dài để giải thích ngoại lệ" } };
  assert.deepEqual(violations(entry, ["catalog_variant_index", "sales_channel"]), []);
  assert.deepEqual(violations({ name: "y" }, ["outbox_event", "outbox_event", "sales_channel"]), [
    "outbox_event",
  ]);
  assert.deepEqual(violations({ name: "z" }, []), []);
});

test("tooSmall: thiếu bảng hoặc ít dòng hơn ngưỡng (kể cả 0/null/chuỗi bigint)", () => {
  const large = { a: 10, b: 5, c: 1 };
  assert.deepEqual(tooSmall({ a: "10", b: 4, c: null }, large), [
    { table: "b", rows: 4, min: 5 },
    { table: "c", rows: 0, min: 1 },
  ]);
  assert.deepEqual(tooSmall({ a: "100", b: "5", c: 1 }, large), []);
  assert.deepEqual(tooSmall({}, { a: 1 }), [{ table: "a", rows: 0, min: 1 }]);
});

test("validateHotPaths: tên trùng/sai, thiếu source, allowSeqScan cho bảng nhỏ hoặc lý do rỗng", () => {
  const ok = { name: "a-b", source: "x.ts", build: () => ({}) };
  assert.deepEqual(validateHotPaths([ok]), []);
  const errs = validateHotPaths([
    ok,
    ok,
    { name: "Bad Name", source: "", build: null },
    {
      name: "c",
      source: "y",
      build: () => ({}),
      allowSeqScan: { sales_channel: "lý do rất dài nhưng bảng nhỏ", outbox_event: "" },
    },
  ]);
  assert.ok(errs.some((e) => e.includes("tên trùng: a-b")));
  assert.ok(errs.some((e) => e.includes("tên không hợp lệ: Bad Name")));
  assert.ok(errs.some((e) => e.includes("thiếu source")));
  assert.ok(errs.some((e) => e.includes("thiếu build")));
  assert.ok(errs.some((e) => e.includes("không thuộc LARGE_TABLES: sales_channel")));
  assert.ok(errs.some((e) => e.includes("lý do allowSeqScan quá ngắn (outbox_event)")));
});

test("hotPaths thật: danh sách hợp lệ, mọi câu dựng được và khớp số tham số (gồm listingSql của backend)", async () => {
  const list = hotPaths(await loadCatalogQuery(root));
  assert.deepEqual(validateHotPaths(list), []);
  assert.ok(list.length >= 20);
  const ctx = {
    channelIds: ["sc_1", "sc_2"],
    now: new Date("2026-10-26T00:00:00Z"),
    ref: (i) => String(i).padStart(7, "0"),
  };
  for (const e of list) {
    const { sql, bindings } = e.build(ctx);
    assert.ok(Array.isArray(bindings), e.name);
    assert.doesNotThrow(() => toPgPlaceholders(sql, bindings.length), e.name);
  }
  // Ngoại lệ Seq Scan chỉ dành cho catalog toàn kênh (không danh mục) — truy vấn đơn/checkout/job không được miễn.
  const exempt = list.filter((e) => e.allowSeqScan).map((e) => e.name);
  assert.deepEqual(exempt.sort(), [
    "catalog-listing-all",
    "catalog-search-short-terms",
    "catalog-search-sku",
  ]);
  assert.ok(Object.keys(LARGE_TABLES).includes("outbox_event"));
});

test("renderSummary: một dòng mỗi truy vấn, đánh dấu FAIL và bảng được phép", () => {
  const md = renderSummary(
    [
      { name: "a", execMs: 1.234, buffers: 5, bad: [], allowed: [] },
      { name: "b", execMs: 10, buffers: 50, bad: ["outbox_event"], allowed: [] },
      { name: "c", execMs: 2, buffers: 7, bad: [], allowed: ["catalog_variant_index"] },
    ],
    { date: "2026-10-26 00:00 UTC", db: "xshop_perf", pg: "16.15", counts: { outbox_event: "600000" } },
  );
  assert.match(md, /\| \[a\]\(a\.txt\) \| 1\.23 \| 5 \| đạt \|/);
  assert.match(md, /\*\*FAIL\*\* Seq Scan: outbox_event/);
  assert.match(md, /cho phép Seq Scan: catalog_variant_index/);
});

test("perf-dataset: chặn DB/Redis của việc khác và tham số vô lý", () => {
  const base = { dbName: "xshop_perf", redisDb: 14, products: 10_000, orders: 200_000, reindexRuns: 2 };
  assert.doesNotThrow(() => assertSafePerfTargets(base));
  assert.doesNotThrow(() => assertSafePerfTargets({ ...base, dbName: "xshop_perf_2" }));
  for (const bad of [
    { dbName: "xshop" },
    { dbName: "xshop_load" },
    { dbName: 'xshop_perf"; drop' },
    { redisDb: 0 },
    { redisDb: 7 },
    { redisDb: 13 },
    { redisDb: 15 },
    { redisDb: 16 },
    { products: 0 },
    { orders: 999 },
    { orders: 1.5 },
    { reindexRuns: 0 },
  ]) {
    assert.throws(() => assertSafePerfTargets({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
});

test("perf-dataset: câu SQL lịch sử đơn tất định, đủ bảng, tham số không hợp lệ bị từ chối", () => {
  const a = orderHistoryStatements(200_000);
  assert.deepEqual(a, orderHistoryStatements(200_000));
  const joined = a.join("\n");
  for (const t of [
    "order_finance",
    "checkout_attempt",
    "cart_version",
    "payment_attempt",
    "payment_ledger",
    "webhook_inbox",
    "outbox_event",
    "ops_exception",
    "shipment",
  ]) {
    assert.match(joined, new RegExp(`INSERT INTO ${t} `), t);
  }
  assert.equal(recentTail(200_000), 200);
  assert.equal(recentTail(1_000), 20);
  assert.throws(() => orderHistoryStatements(0));
  assert.throws(() => orderHistoryStatements(-1));
});
