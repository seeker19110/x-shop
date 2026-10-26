import assert from "node:assert/strict";
import { test } from "node:test";
import { datasetStatements, expectedSkuCount, SHAPES } from "./dataset.mjs";
import { assertSafeTargets } from "./env.mjs";
import {
  classify,
  createDeck,
  evaluatePhase,
  fakeIp,
  groupOf,
  groupSamples,
  initialStock,
  mulberry32,
  percentile,
  pickWeighted,
  READ_MIX,
  summarize,
  summarizeByOp,
  THRESHOLDS,
  variantIdOf,
  WRITE_MIX,
} from "./lib.mjs";
import { renderOpTable, renderReport } from "./report.mjs";

const s = (op, ms, outcome = "ok", status = 200) => ({ op, ms, outcome, status });

test("mulberry32: tất định theo seed, khác seed → khác dãy, trong [0,1)", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(
    xs,
    Array.from({ length: 50 }, () => b()),
  );
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, mulberry32(8)));
});

test("pickWeighted: tổng trọng số 0 → lỗi; trọng số 0 không bao giờ được chọn", () => {
  assert.throws(() => pickWeighted(mulberry32(1), []), /trọng số/);
  assert.throws(() => pickWeighted(mulberry32(1), [["a", 0]]), /trọng số/);
  const rng = mulberry32(3);
  for (let i = 0; i < 200; i++)
    assert.equal(
      pickWeighted(rng, [
        ["a", 0],
        ["b", 5],
      ]),
      "b",
    );
});

test("createDeck: mọi 10 request liên tiếp đúng 60/20/20 (read) và mọi 5 thao tác đúng 3/1/1 (write)", () => {
  const next = createDeck(mulberry32(42), READ_MIX);
  for (let round = 0; round < 20; round++) {
    const got = Array.from({ length: 5 }, next); // gcd(60,20,20)=20 → bộ bài 3+1+1 lá
    assert.equal(got.filter((x) => x === "listing").length, 3);
    assert.equal(got.filter((x) => x === "pdp").length, 1);
    assert.equal(got.filter((x) => x === "search").length, 1);
  }
  const w = createDeck(mulberry32(1), WRITE_MIX);
  const ops = Array.from({ length: 100 }, w);
  assert.equal(ops.filter((x) => x === "cart_edit").length, 60);
  assert.equal(ops.filter((x) => x === "quote").length, 20);
  assert.equal(ops.filter((x) => x === "submit").length, 20);
});

test("createDeck: trọng số không hợp lệ bị từ chối", () => {
  assert.throws(() => createDeck(mulberry32(1), []), /bộ bài/);
  assert.throws(() => createDeck(mulberry32(1), [["a", 0.5]]), /bộ bài/);
  assert.throws(
    () =>
      createDeck(mulberry32(1), [
        ["a", -1],
        ["b", 3],
      ]),
    /bộ bài/,
  );
});

test("percentile: nearest-rank, rỗng → null (dùng chung với perf/lib)", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      95,
    ),
    95,
  );
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, i) => i + 1),
      95,
    ),
    19,
  );
});

test("classify: mạng/timeout, 5xx, 429 luôn là lỗi; 4xx chỉ là nghiệp vụ khi được cho phép", () => {
  assert.equal(classify("pdp", 200), "ok");
  assert.equal(classify("submit", 202), "ok");
  assert.equal(classify("pdp", 0), "error");
  assert.equal(classify("pdp", Number.NaN), "error");
  assert.equal(classify("pdp", 500), "error");
  assert.equal(classify("pdp", 503), "error");
  assert.equal(classify("search", 429), "error");
  assert.equal(classify("search", 429, { allowBusiness: [429] }), "error");
  assert.equal(classify("submit", 409), "error");
  assert.equal(classify("submit", 409, { allowBusiness: [409] }), "business");
  assert.equal(classify("pdp", 404), "error");
  assert.equal(classify("quote", 422), "error");
});

test("groupOf: gán nhóm đo đúng; request chuẩn bị không vào nhóm có ngưỡng", () => {
  for (const op of ["listing", "pdp", "search"]) assert.equal(groupOf(op), "read");
  for (const op of ["cart_create", "cart_add", "cart_update", "quote"]) assert.equal(groupOf(op), "write");
  assert.equal(groupOf("submit"), "checkout");
  for (const op of ["setup_cart_add", "setup_quote", "submit_replay", "contention_submit", "harness"]) {
    assert.equal(groupOf(op), "setup");
  }
});

test("summarize: rỗng → null (không phải 0); đếm lỗi/nghiệp vụ; mã lỗi gom theo trạng thái:mã", () => {
  const empty = summarize([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.p95, null);
  assert.equal(empty.errorRate, null);
  const r = summarize([
    s("a", 10),
    s("a", 20),
    { op: "a", ms: 30, outcome: "error", status: 503, code: "X" },
    { op: "a", ms: 40, outcome: "business", status: 409, code: "Y" },
  ]);
  assert.equal(r.errors, 1);
  assert.equal(r.business, 1);
  assert.equal(r.errorRate, 0.25);
  assert.equal(r.max, 40);
  assert.deepEqual(r.codes, { "503:X": 1, "409:Y": 1 });
});

test("evaluatePhase: đúng bằng ngưỡng là đạt, hơn 1 ms là vượt; nhóm không có mẫu KHÔNG đạt", () => {
  const mk = (readMs, writeMs, coMs) => [
    ...Array.from({ length: 20 }, () => s("listing", readMs)),
    ...Array.from({ length: 20 }, () => s("quote", writeMs)),
    ...Array.from({ length: 20 }, () => s("submit", coMs)),
  ];
  const ok = evaluatePhase(groupSamples(mk(300, 700, 2000)));
  assert.equal(ok.ok, true);
  const over = evaluatePhase(groupSamples(mk(301, 700, 2000)));
  assert.equal(over.ok, false);
  assert.equal(over.rows.find((r) => r.group === "read").ok, false);
  assert.equal(over.rows.find((r) => r.group === "write").ok, true);
  // Burst: ngưỡng ×2.
  assert.equal(evaluatePhase(groupSamples(mk(600, 1400, 4000)), { factor: 2 }).ok, true);
  assert.equal(evaluatePhase(groupSamples(mk(601, 1400, 4000)), { factor: 2 }).ok, false);
  // Không có request ghi nào → không đo được ≠ đạt.
  const noWrite = evaluatePhase(groupSamples(Array.from({ length: 20 }, () => s("listing", 10))));
  assert.equal(noWrite.ok, false);
  assert.equal(noWrite.rows.find((r) => r.group === "write").ok, false);
});

test("evaluatePhase: tỷ lệ lỗi < 0,5% (đúng 0,5% là không đạt); request bị bỏ làm pha không đạt", () => {
  const base = Array.from({ length: 199 }, () => s("listing", 10));
  const withErr = [...base, { op: "listing", ms: 10, outcome: "error", status: 500 }]; // 1/200 = 0,5%
  const rest = [
    ...Array.from({ length: 20 }, () => s("quote", 10)),
    ...Array.from({ length: 20 }, () => s("submit", 10)),
  ];
  assert.equal(evaluatePhase(groupSamples([...withErr, ...rest])).rows[0].okErrors, false);
  assert.equal(evaluatePhase(groupSamples([...base, ...rest])).ok, true);
  assert.equal(evaluatePhase(groupSamples([...base, ...rest]), { dropped: 1 }).ok, false);
  // Lỗi ở nhóm setup vẫn kéo tỷ lệ lỗi chung.
  const setupErrs = Array.from({ length: 5 }, () => ({
    op: "setup_cart_add",
    ms: 1,
    outcome: "error",
    status: 500,
  }));
  assert.equal(evaluatePhase(groupSamples([...base, ...rest, ...setupErrs])).okOverall, false);
});

test("summarizeByOp: gom theo op, sắp theo tên", () => {
  const r = summarizeByOp([s("pdp", 5), s("listing", 7), s("pdp", 9)]);
  assert.deepEqual(
    r.map((x) => [x.op, x.count]),
    [
      ["listing", 1],
      ["pdp", 2],
    ],
  );
  assert.match(renderOpTable(r), /\| pdp \| 2 \|/);
  assert.equal(renderOpTable([]).split("\n").length, 2);
});

test("fakeIp: IPv4 hợp lệ trong dải 100.64.0.0/10, không trùng với 70.000 khách đầu, quay vòng không lỗi", () => {
  const seen = new Set();
  for (let i = 0; i < 70_000; i++) {
    const ip = fakeIp(i);
    assert.match(ip, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/);
    seen.add(ip);
  }
  assert.equal(seen.size, 70_000);
  assert.equal(fakeIp(64 * 256 * 256), fakeIp(0));
});

test("dataset: đúng 50.000 SKU cho 10.000 sản phẩm; hình dạng khớp công thức SQL; id biến thể 5 chữ số", () => {
  assert.equal(expectedSkuCount(10_000), 50_000);
  assert.equal(expectedSkuCount(1), 5);
  assert.equal(expectedSkuCount(0), 0);
  assert.equal(
    SHAPES.reduce((a, x) => a + x.colors * x.sizes, 0),
    20,
  );
  assert.equal(variantIdOf(7, 0, 4), "variant_LD0000704");
  assert.equal(variantIdOf(10_000, 1, 2), "variant_LD1000012");
  // Tồn: SKU có seq chia hết cho 20 hết hàng (5%); còn lại 5..60 và nguyên.
  assert.equal(initialStock(2, 0, 0), 0);
  assert.equal(initialStock(0, 1, 0), 5 + ((5 * 7) % 56));
  for (let n = 1; n < 500; n++)
    for (let ci = 0; ci < 2; ci++)
      for (let si = 0; si < 5; si++) {
        const v = initialStock(n, ci, si);
        assert.ok(Number.isInteger(v) && v >= 0 && v <= 60);
      }
});

test("dataset: số sản phẩm sai → lỗi; câu lệnh không dùng Math.random/now() (tất định)", () => {
  for (const bad of [0, -1, 1.5, 100_000, Number.NaN])
    assert.throws(() => datasetStatements(bad), /không hợp lệ/);
  const sql = datasetStatements(10).join("\n");
  assert.doesNotMatch(sql, /random\(\)|now\(\)|clock_timestamp|gen_random_uuid/i);
});

test("env: DB/Redis tải phải có tiền tố an toàn; không cho trỏ vào DB dev/E2E hay Redis 0/7", () => {
  const ok = { dbName: "xshop_load", redisDb: 13, products: 10_000 };
  assert.doesNotThrow(() => assertSafeTargets(ok));
  assert.doesNotThrow(() => assertSafeTargets({ ...ok, dbName: "xshop_load_b" }));
  for (const dbName of ["xshop", "xshop_e2e", "postgres", "xshop_load; DROP", "XSHOP_LOAD", ""]) {
    assert.throws(() => assertSafeTargets({ ...ok, dbName }), /LOAD_DB_NAME/);
  }
  for (const redisDb of [0, 7, 16, -1, 1.5, Number.NaN]) {
    assert.throws(() => assertSafeTargets({ ...ok, redisDb }), /LOAD_REDIS_DB/);
  }
  assert.throws(() => assertSafeTargets({ ...ok, products: 0 }), /LOAD_PRODUCTS/);
});

test("renderReport: có ngưỡng, kết quả, bảng tính đúng; dữ liệu rỗng không làm hỏng báo cáo", () => {
  const evaluation = evaluatePhase(groupSamples([]));
  const md = renderReport({
    date: "2026-01-01T00:00:00.000Z",
    config: {
      seed: 1,
      dbName: "xshop_load",
      redisDb: 13,
      port: 9200,
      readRps: 5,
      writeRps: 0.5,
      coldSeconds: 1,
      steadySeconds: 1,
      burstSeconds: 1,
    },
    machine: { cpus: 4, cpuModel: "x", memGiB: "16", node: "v22", pg: "PostgreSQL 16", loadavg: "0" },
    timings: { migrate: 1500, reused: 1 },
    dataset: null,
    phases: [
      {
        name: "steady",
        seconds: 1,
        factor: 1,
        gating: true,
        issued: { read: 0, write: 0 },
        evaluation,
        byOp: [],
      },
    ],
    checks: [{ name: "k", ok: false, detail: "d" }],
    cache: { hit: 0, read: 0 },
    ok: false,
  });
  assert.match(md, /KHÔNG ĐẠT/);
  assert.match(md, /p95 đọc ≤ 300 ms/);
  assert.match(md, /Không đo được/);
  assert.match(md, /20× nhỏ hơn/);
  assert.equal(THRESHOLDS.p95Ms.checkout, 2000);
});
