// Test hàm thuần của check-schema.mjs (T-101): node --test scripts/ops/check-schema.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analyze,
  assertSafeDbName,
  ENUM_ALLOW,
  fkCovered,
  hasEnumCheck,
  hasLowerBound,
  NULLABLE_ALLOW,
  NUMERIC_ALLOW,
  projectTables,
  scanModules,
  SCHEMA_DB,
  snapshotColumns,
} from "./check-schema.mjs";

const NONE = { nullable: {}, numeric: {}, enum: {}, fk: {} };
const REASON = "lý do đủ dài cho allowlist của test";
const tables = (...names) => new Map(names.map((n) => [n, "mod"]));
const catalog = (o = {}) => ({ columns: [], checks: [], fks: [], indexes: [], ...o });
const col = (table, column, type = "text", nullable = false) => ({ table, column, type, nullable });
const rules = (vs) => vs.map((v) => `${v.rule} ${v.table}${v.column ? `.${v.column}` : ""}`).sort();

test("hasLowerBound: nhận >=/>, có ngoặc/null-or; không nhầm cột cùng hậu tố, <=, <>", () => {
  assert.ok(hasLowerBound(["CHECK ((amount >= 0))"], "amount"));
  assert.ok(hasLowerBound(["CHECK (((shipping_fee IS NULL) OR (shipping_fee >= 0)))"], "shipping_fee"));
  assert.ok(hasLowerBound(["CHECK ((compare_at > price))"], "compare_at"));
  assert.ok(hasLowerBound(['CHECK (("rows" > 0))'], "rows"));
  assert.ok(!hasLowerBound(["CHECK ((received_quantity >= 0))"], "quantity"));
  assert.ok(!hasLowerBound(["CHECK ((received_quantity <= quantity))"], "quantity"));
  assert.ok(!hasLowerBound(["CHECK ((delta <> 0))"], "delta"));
  assert.ok(!hasLowerBound(["CHECK ((stocked_after >= reserved_quantity))"], "reserved_quantity"));
  assert.ok(!hasLowerBound([], "amount"));
});

test("hasEnumCheck: nhận = ANY (ARRAY[…]) và = '…'::text; không nhận cột khác/so sánh khác", () => {
  assert.ok(hasEnumCheck(["CHECK ((state = ANY (ARRAY['a'::text, 'b'::text])))"], "state"));
  assert.ok(hasEnumCheck(["CHECK ((unit = 'cm'::text))"], "unit"));
  assert.ok(
    hasEnumCheck(["CHECK (((from_state IS NULL) OR (from_state = ANY (ARRAY['x'::text]))))"], "from_state"),
  );
  assert.ok(!hasEnumCheck(["CHECK ((settlement_state = ANY (ARRAY['a'::text])))"], "state"));
  assert.ok(!hasEnumCheck(["CHECK ((length(state) > 0))"], "state"));
  assert.ok(!hasEnumCheck([], "state"));
});

test("fkCovered: cần index hợp lệ, không partial, cột FK dẫn đầu (thứ tự trong nhóm tuỳ ý)", () => {
  const ix = (columns, o = {}) => ({ columns, partial: false, valid: true, ...o });
  assert.ok(fkCovered(["a"], [ix(["a"])]));
  assert.ok(fkCovered(["a"], [ix(["a", "b"])]));
  assert.ok(fkCovered(["a", "b"], [ix(["b", "a", "c"])]));
  assert.ok(!fkCovered(["a"], [ix(["b", "a"])]));
  assert.ok(!fkCovered(["a"], [ix(["a"], { partial: true })]));
  assert.ok(!fkCovered(["a"], [ix(["a"], { valid: false })]));
  assert.ok(!fkCovered(["a", "b"], [ix(["a"])]));
  assert.ok(!fkCovered(["a"], [ix([null, "a"])])); // index biểu thức
  assert.ok(!fkCovered(["a"], []));
});

test("analyze: FK không khai ON DELETE / không index → vi phạm; RESTRICT + index thường → đạt", () => {
  const fk = (onDelete) => ({
    table: "child",
    name: "child_fk",
    columns: ["parent_id"],
    ref: "parent",
    onDelete,
  });
  const columns = [col("child", "parent_id")];
  const bad = analyze(catalog({ columns, fks: [fk("a")], indexes: [] }), {
    tables: tables("child"),
    allow: NONE,
  });
  assert.deepEqual(rules(bad), ["FK_INDEX child", "FK_ON_DELETE child"]);
  const partial = analyze(
    catalog({
      columns,
      fks: [fk("r")],
      indexes: [{ table: "child", name: "i", columns: ["parent_id"], partial: true, valid: true }],
    }),
    { tables: tables("child"), allow: NONE },
  );
  assert.deepEqual(rules(partial), ["FK_INDEX child"]);
  const ok = analyze(
    catalog({
      columns,
      fks: [fk("c")],
      indexes: [{ table: "child", name: "i", columns: ["parent_id"], partial: false, valid: true }],
    }),
    { tables: tables("child"), allow: NONE },
  );
  assert.deepEqual(ok, []);
  // FK của bảng ngoài phạm vi (native Medusa) bị bỏ qua.
  assert.deepEqual(analyze(catalog({ fks: [fk("a")] }), { tables: tables("other"), allow: NONE }), [
    { rule: "MISSING_TABLE", table: "other", message: "migration tạo bảng nhưng DB không có" },
  ]);
});

test("analyze: nullable — model DML khai bắt buộc luôn lỗi; model nullable hoặc allowlist thì đạt", () => {
  const snapshot = new Map([
    [
      "t",
      new Map([
        ["a", { nullable: false }],
        ["b", { nullable: true }],
      ]),
    ],
  ]);
  const cols = [col("t", "a", "text", true), col("t", "b", "text", true), col("t", "c", "text", true)];
  const allow = { ...NONE, nullable: { "t.a": REASON, "t.c": REASON } };
  const vs = analyze(catalog({ columns: cols }), { tables: tables("t"), snapshot, allow });
  // t.a: model bắt buộc → lỗi dù có allowlist (và mục allowlist t.a thành thừa).
  assert.deepEqual(rules(vs), ["ALLOWLIST t.a", "NOT_NULL t.a"]);
  const noReason = analyze(catalog({ columns: [col("t", "c", "text", true)] }), {
    tables: tables("t"),
    allow: NONE,
  });
  assert.deepEqual(rules(noReason), ["NOT_NULL t.c"]);
});

test("analyze: cột số thiếu cận dưới / cột trạng thái thiếu tập giá trị → vi phạm; CHECK đúng → đạt", () => {
  const cols = [
    col("t", "amount", "bigint"),
    col("t", "qty", "integer"),
    col("t", "state", "text"),
    col("t", "payment_method", "text"),
    col("t", "note", "text"),
    col("t", "result", "jsonb"),
  ];
  const bad = analyze(catalog({ columns: cols }), { tables: tables("t"), allow: NONE });
  assert.deepEqual(rules(bad), [
    "CHECK_BOUND t.amount",
    "CHECK_BOUND t.qty",
    "CHECK_ENUM t.payment_method",
    "CHECK_ENUM t.state",
  ]);
  const checks = [
    "CHECK ((amount >= 0))",
    "CHECK ((qty > 0))",
    "CHECK ((state = ANY (ARRAY['a'::text])))",
    "CHECK ((payment_method = ANY (ARRAY['cod'::text])))",
  ].map((def) => ({ table: "t", def }));
  assert.deepEqual(analyze(catalog({ columns: cols, checks }), { tables: tables("t"), allow: NONE }), []);
});

test("analyze: allowlist thừa hoặc lý do quá ngắn → vi phạm ALLOWLIST", () => {
  const cols = [col("t", "rank", "integer")];
  const short = analyze(catalog({ columns: cols }), {
    tables: tables("t"),
    allow: { ...NONE, numeric: { "t.rank": "ngắn" } },
  });
  assert.deepEqual(rules(short), ["ALLOWLIST t.rank"]);
  const stale = analyze(catalog({ columns: cols, checks: [{ table: "t", def: "CHECK ((rank >= 0))" }] }), {
    tables: tables("t"),
    allow: { ...NONE, numeric: { "t.rank": REASON }, enum: { "t.gone": REASON } },
  });
  assert.deepEqual(rules(stale), ["ALLOWLIST t.gone", "ALLOWLIST t.rank"]);
});

test("analyze: tên migration trùng giữa module / chưa áp vào DB → vi phạm MIGRATION_NAME", () => {
  const migrations = [
    { module: "a", name: "Migration1" },
    { module: "b", name: "Migration1" },
    { module: "b", name: "Migration2" },
  ];
  const vs = analyze(catalog({ applied: ["Migration1"] }), { tables: new Map(), migrations, allow: NONE });
  assert.deepEqual(rules(vs), ["MIGRATION_NAME Migration1", "MIGRATION_NAME Migration2"]);
  assert.match(vs.find((v) => v.table === "Migration1").message, /trùng giữa module a, b/);
  // Không đọc được mikro_orm_migrations (catalog tổng hợp) → chỉ kiểm trùng tên.
  assert.deepEqual(
    analyze(catalog(), { tables: new Map(), migrations: migrations.slice(1), allow: NONE }),
    [],
  );
});

test("scanModules/snapshotColumns: đọc bảng từ create table, bỏ file không phải Migration*.ts, đọc nullable snapshot", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "check-schema-"));
  try {
    mkdirSync(path.join(dir, "m1/migrations"), { recursive: true });
    mkdirSync(path.join(dir, "m2"), { recursive: true }); // module không có migrations
    writeFileSync(
      path.join(dir, "m1/migrations/Migration1.ts"),
      `this.addSql(\`CREATE TABLE IF NOT EXISTS "t_one" (…)\`); this.addSql(\`create table if not exists "t_two" (\`);`,
    );
    writeFileSync(path.join(dir, "m1/migrations/helper.ts"), `create table if not exists "not_mine" (`);
    writeFileSync(
      path.join(dir, "m1/migrations/.snapshot-m1.json"),
      JSON.stringify({
        tables: [{ name: "t_one", columns: { a: { nullable: true }, b: { nullable: false } } }],
      }),
    );
    const { tables: t, migrations } = scanModules(dir);
    assert.deepEqual([...t.entries()].sort(), [
      ["t_one", "m1"],
      ["t_two", "m1"],
    ]);
    assert.deepEqual(migrations, [{ module: "m1", name: "Migration1" }]);
    const snap = snapshotColumns(dir);
    assert.deepEqual(snap.get("t_one").get("a"), { nullable: true });
    assert.deepEqual(snap.get("t_one").get("b"), { nullable: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo thật: bảng dự án gồm cả bảng SQL tay và DML, không có bảng native Medusa; allowlist trỏ vào bảng dự án", () => {
  const t = projectTables();
  for (const name of ["checkout_attempt", "x_refund", "audit_log", "fashion_model_measurement", "user_role"])
    assert.ok(t.has(name), name);
  for (const name of ["order", "product", "cart", "payment"]) assert.ok(!t.has(name), name);
  for (const key of [
    ...Object.keys(NULLABLE_ALLOW),
    ...Object.keys(NUMERIC_ALLOW),
    ...Object.keys(ENUM_ALLOW),
  ])
    assert.ok(t.has(key.split(".")[0]), key);
  const names = scanModules().migrations.map((m) => m.name);
  assert.equal(new Set(names).size, names.length, "tên migration phải duy nhất giữa các module");
});

test("tên DB dùng một lần: mặc định theo pid (hai lần chạy song song không đụng nhau), chặn tên ngoài tiền tố", () => {
  assert.equal(SCHEMA_DB.dbName, `xshop_schema_${process.pid}`);
  assert.doesNotThrow(() => assertSafeDbName("xshop_schema_123"));
  for (const bad of ["xshop", "xshop_perf", "xshop_schema-1", 'xshop_schema"; drop', "postgres"])
    assert.throws(() => assertSafeDbName(bad), /SCHEMA_DB_NAME/);
});
