// Test hàm thuần của check-vacuum.mjs (T-196) bằng dữ liệu giả, không cần DB: node --test scripts/ops/check-vacuum.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateVacuum,
  HOT_TABLES,
  main,
  MAX_DEAD_RATIO,
  MAX_XID_AGE,
  MIN_DEAD_TUPLES,
  THRESHOLDS,
  toCount,
} from "./check-vacuum.mjs";

/** Thống kê ổn cho cả bốn bảng; `pg` trả bigint dạng chuỗi, int4 dạng number. */
const healthy = (over = {}) => ({
  autovacuum: "on",
  databases: [
    { datname: "postgres", xid_age: 1_234 },
    { datname: "xshop", xid_age: 50_000_000 },
  ],
  tables: HOT_TABLES.map((relname) => ({ relname, n_live_tup: "100000", n_dead_tup: "500" })),
  ...over,
});
const withTable = (relname, n_live_tup, n_dead_tup) =>
  healthy({
    tables: healthy().tables.map((t) => (t.relname === relname ? { relname, n_live_tup, n_dead_tup } : t)),
  });

test("hằng số đầu file: bốn bảng của migration T-196, ngưỡng như tài liệu", () => {
  assert.deepEqual([...HOT_TABLES], ["outbox_event", "rate_limit_counter", "webhook_inbox", "audit_log"]);
  assert.equal(MAX_XID_AGE, 2 * 200_000_000); // 2 × autovacuum_freeze_max_age mặc định
  assert.ok(MAX_XID_AGE < 2 ** 31 - 40_000_000, "phải báo trước mốc cảnh báo của máy chủ");
  assert.equal(MAX_DEAD_RATIO, 0.2);
  assert.equal(MIN_DEAD_TUPLES, 1_000);
  assert.ok(Object.isFrozen(HOT_TABLES) && Object.isFrozen(THRESHOLDS));
});

test("mọi thứ ổn → ok, mỗi mục một dòng ok, không vấn đề", () => {
  const r = evaluateVacuum(healthy());
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.lines.length, 1 + 1 + 4); // autovacuum · một dòng gộp database · bốn bảng
  assert.ok(r.lines.every((l) => l.startsWith("ok   ")));
  assert.equal(
    r.lines[1],
    `ok   2 database: age(datfrozenxid) lớn nhất = 50000000 (xshop, ngưỡng ${MAX_XID_AGE})`,
  );
});

test("autovacuum off / vắng → vấn đề", () => {
  for (const v of ["off", undefined, null, ""]) {
    const r = evaluateVacuum(healthy({ autovacuum: v }));
    assert.equal(r.ok, false, String(v));
    assert.match(r.problems[0], /^autovacuum = .* \(phải on\)$/);
  }
});

test("tuổi XID: đúng ngưỡng là ổn, vượt 1 là vấn đề; xét MỌI database", () => {
  const at = evaluateVacuum(healthy({ databases: [{ datname: "xshop", xid_age: MAX_XID_AGE }] }));
  assert.equal(at.ok, true);
  const over = evaluateVacuum(
    healthy({
      databases: [
        { datname: "xshop", xid_age: 10 },
        { datname: "template1", xid_age: MAX_XID_AGE + 1 },
      ],
    }),
  );
  assert.equal(over.ok, false);
  assert.deepEqual(over.problems, [
    `database template1: age(datfrozenxid) = ${MAX_XID_AGE + 1} (ngưỡng ${MAX_XID_AGE})`,
  ]);
  assert.ok(
    over.lines.includes(`ok   1 database: age(datfrozenxid) lớn nhất = 10 (xshop, ngưỡng ${MAX_XID_AGE})`),
  );
  // Mọi DB vượt → không có dòng gộp "ok".
  const all = evaluateVacuum(healthy({ databases: [{ datname: "a", xid_age: MAX_XID_AGE + 5 }] }));
  assert.ok(!all.lines.some((l) => l.includes("database")));
  // Chuỗi số (bigint) và 0 đều đọc được.
  assert.equal(evaluateVacuum(healthy({ databases: [{ datname: "x", xid_age: "0" }] })).ok, true);
});

test("pg_database rỗng / không phải mảng → lỗi (exit 2), không coi là ổn", () => {
  assert.throws(() => evaluateVacuum(healthy({ databases: [] })), /pg_database không trả dòng nào/);
  assert.throws(() => evaluateVacuum(healthy({ databases: undefined })), /pg_database không trả dòng nào/);
});

test("tỉ lệ dead/live: đúng ngưỡng ổn, vượt là vấn đề", () => {
  assert.equal(evaluateVacuum(withTable("outbox_event", "10000", "2000")).ok, true); // 0.2
  const r = evaluateVacuum(withTable("outbox_event", "10000", "2001"));
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^bảng outbox_event: n_dead_tup = 2001, n_live_tup = 10000, tỉ lệ 0\.200 /);
});

test("dưới MIN_DEAD_TUPLES không xét tỉ lệ (bảng gần rỗng); từ MIN trở lên thì xét", () => {
  assert.equal(evaluateVacuum(withTable("rate_limit_counter", "10", String(MIN_DEAD_TUPLES - 1))).ok, true);
  assert.equal(evaluateVacuum(withTable("rate_limit_counter", "10", String(MIN_DEAD_TUPLES))).ok, false);
});

test("live = 0: dead = 0 ổn; dead ≥ MIN là tỉ lệ vô hạn → vấn đề", () => {
  assert.equal(evaluateVacuum(withTable("webhook_inbox", "0", "0")).ok, true);
  const r = evaluateVacuum(withTable("webhook_inbox", 0, 5_000));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /tỉ lệ ∞/);
});

test("bảng vắng trong pg_stat_user_tables → vấn đề (sai DB/chưa migrate); bảng lạ bị bỏ qua", () => {
  const tables = healthy().tables.filter((t) => t.relname !== "audit_log");
  tables.push({ relname: "khac", n_live_tup: "1", n_dead_tup: "999999" });
  const r = evaluateVacuum(healthy({ tables }));
  assert.deepEqual(r.problems, [
    "bảng audit_log: không có trong pg_stat_user_tables (sai DB hoặc chưa migrate)",
  ]);
  assert.equal(evaluateVacuum(healthy({ tables: undefined })).problems.length, 4);
});

test("nhiều vấn đề cùng lúc → liệt kê đủ", () => {
  const r = evaluateVacuum({
    ...withTable("audit_log", "100", "5000"),
    autovacuum: "off",
    databases: [{ datname: "xshop", xid_age: 2_100_000_000 }],
  });
  assert.equal(r.problems.length, 3);
});

test("ngưỡng truyền vào thay hằng số mặc định", () => {
  const strict = { ...THRESHOLDS, maxXidAge: 10, tables: ["outbox_event"] };
  const r = evaluateVacuum(healthy(), strict);
  assert.equal(r.problems.length, 2); // hai database > 10
  assert.equal(r.lines.filter((l) => l.includes("bảng")).length, 1);
});

test("toCount: số/chuỗi số nguyên không âm; giá trị hỏng → RangeError", () => {
  assert.equal(toCount(0, "x"), 0);
  assert.equal(toCount("42", "x"), 42);
  assert.equal(toCount("9007199254740991", "x"), Number.MAX_SAFE_INTEGER);
  for (const bad of [
    null,
    undefined,
    -1,
    1.5,
    "",
    " 1",
    "-1",
    "1e3",
    "9007199254740992",
    NaN,
    Infinity,
    {},
  ]) {
    assert.throws(
      () => toCount(bad, "n_dead_tup"),
      /n_dead_tup: giá trị không phải số đếm hợp lệ/,
      String(bad),
    );
  }
  assert.throws(() => evaluateVacuum(withTable("outbox_event", null, "1")), /outbox_event\.n_live_tup/);
});

test("main: thiếu DATABASE_URL → 2", async () => {
  assert.equal(await main({}), 2);
  assert.equal(await main({ DATABASE_URL: "" }), 2);
});

test("main: lỗi kết nối (cổng đóng, URL sai cú pháp) → 2, không in URL/mật khẩu", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    assert.equal(await main({ DATABASE_URL: "postgres://u:BI_MAT_T196@127.0.0.1:1/x" }), 2);
    assert.equal(await main({ DATABASE_URL: "postgres://u:BI_MAT_T196@[khong-hop-le" }), 2);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.startsWith("[vacuum] LỖI kết nối/truy vấn:")));
  assert.ok(errors.every((e) => !e.includes("BI_MAT_T196")));
});
