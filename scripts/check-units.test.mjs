import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyColumns, checkUnits, classifyColumn, main, modelColumns, tableKey } from "./check-units.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REASON = "Tiền VND số nguyên, cột đã áp không đổi tên được (DB-MIG-003).";
const quiet = { log() {}, error() {} };

test("classifyColumn: đại lượng có đơn vị mà thiếu hậu tố bị bắt", () => {
  assert.deepEqual(classifyColumn("timeout"), { dimension: "thời lượng", word: "timeout" });
  assert.equal(classifyColumn("cache_ttl")?.word, "ttl");
  assert.equal(classifyColumn("retry_delay")?.dimension, "thời lượng");
  assert.equal(classifyColumn("file_size")?.dimension, "kích thước/khối lượng");
  assert.equal(classifyColumn("weight")?.word, "weight");
  assert.equal(classifyColumn("amount")?.dimension, "tiền");
  assert.equal(classifyColumn("shipping_fee")?.word, "fee");
});

test("classifyColumn: compare/difference/deposit/vat là tiền; expire/retry after là thời lượng", () => {
  for (const n of ["compare_at", "compare_at_price", "difference", "deposit", "vat", "vat_rate_x"])
    assert.equal(classifyColumn(n)?.dimension, "tiền", n);
  for (const n of ["retry_after", "expire_after", "expires", "cache_expires"])
    assert.equal(classifyColumn(n)?.dimension, "thời lượng", n);
  for (const n of ["deposit_vnd", "difference_vnd", "vat_percent", "retry_after_seconds", "expires_ms"])
    assert.equal(classifyColumn(n), null, n);
});

test("classifyColumn: expires_at/expires_on là mốc thời điểm (không báo); stocked_after là số lượng (không báo)", () => {
  for (const n of [
    "expires_at",
    "expires_on",
    "valid_after_date",
    "stocked_after",
    "qty_after",
    "count_after",
  ])
    assert.equal(classifyColumn(n), null, n);
});

test("classifyColumn: có hậu tố đơn vị thì qua", () => {
  for (const n of [
    "timeout_ms",
    "ttl_seconds",
    "window_minutes",
    "file_size_bytes",
    "amount_vnd",
    "height_cm",
    "weight_grams",
    "discount_percent",
    "fee_bps",
    "AMOUNT_VND", // hoa/thường
  ])
    assert.equal(classifyColumn(n), null, n);
});

test("classifyColumn: cột đếm/thứ hạng/không đại lượng không bị bắt (ca biên)", () => {
  for (const n of [
    "rows_total",
    "items_total",
    "attempts",
    "trip_count",
    "size_rank",
    "version",
    "cart_version",
    "rank",
  ])
    assert.equal(classifyColumn(n), null, n);
  assert.equal(classifyColumn(""), null);
  assert.equal(classifyColumn("___"), null);
  assert.equal(classifyColumn(undefined), null); // không ném
});

test("classifyColumn: hậu tố chỉ tính ở token CUỐI (amount_vnd_old vẫn bị bắt vì `amount`)", () => {
  assert.equal(classifyColumn("amount_vnd_old")?.word, "amount");
  // "ms" ở giữa không cứu: `ms_timeout`
  assert.equal(classifyColumn("ms_timeout")?.word, "timeout");
});

test("tableKey: bỏ tiền tố x_ một lần", () => {
  assert.equal(tableKey("x_refund"), "refund");
  assert.equal(tableKey("refund"), "refund");
  assert.equal(tableKey("x_x_a"), "x_a");
});

test("applyColumns: create table lấy cột số, bỏ cột chữ/ràng buộc", () => {
  const cols = applyColumns([
    `create table if not exists "x_demo" ("id" text not null, "timeout" integer not null, "amount" bigint, "note" text, "ratio" numeric(5, 2), constraint "x_demo_pkey" primary key ("id"));`,
  ]);
  assert.deepEqual([...cols.keys()].sort(), ["x_demo.amount", "x_demo.ratio", "x_demo.timeout"]);
  assert.equal(cols.get("x_demo.amount").type, "bigint");
  assert.equal(cols.get("x_demo.ratio").type, "numeric");
});

test("applyColumns: add/alter type/rename/drop áp theo thứ tự (schema cuối)", () => {
  const cols = applyColumns([
    `create table "x_t" ("id" text, "wait" integer);`,
    `alter table "x_t" add column if not exists "lease" integer not null default 0;`,
    `alter table "x_t" alter column "wait" type bigint using "wait"::bigint;`,
    `alter table "x_t" rename column "lease" to "lease_ms";`,
    `alter table "x_t" add column "extra" integer, drop column "wait";`,
  ]);
  assert.deepEqual([...cols.keys()].sort(), ["x_t.extra", "x_t.lease_ms"]);
  assert.equal(cols.get("x_t.lease_ms").column, "lease_ms");
});

test("applyColumns: đổi kiểu sang không-số xoá cột; bảng/cột dựng bằng ${…} bị bỏ qua; SQL rỗng không ném", () => {
  const cols = applyColumns([
    `create table "x_t" ("size" integer);`,
    `alter table "x_t" alter column "size" type text;`,
    'create table "x_${n}" ("timeout" integer);',
    ``,
  ]);
  assert.equal(cols.size, 0);
});

test("applyColumns: tên trích dẫn có Unicode/hoa không làm hỏng parser; chuỗi chứa dấu phẩy/chấm phẩy bị che", () => {
  const cols = applyColumns([
    `create table "x_u" ("Thời_gian" integer, "note" text default 'a, b; "timeout" integer', "delay" integer);`,
  ]);
  assert.deepEqual([...cols.keys()].sort(), ["x_u.delay", "x_u.thời_gian"]);
});

test("modelColumns: bắt model.number()/bigNumber() kể cả chuỗi default/nullable; bỏ qua chú thích và kiểu khác", () => {
  const src = `
    import { model } from "@medusajs/framework/utils";
    // timeout: model.number()
    /** amount: model.number() */
    export const A = model.define("x_a", {
      id: model.id().primaryKey(),
      timeout: model.number().default(0).nullable(),
      amount: model.bigNumber(),
      title: model.text(),
      "weird": model.float(),
    });
    export const B = model
      .define("b", { size: model.number() })
      .indexes([{ on: ["size"] }]);
  `;
  assert.deepEqual(modelColumns(src), [
    { table: "x_a", column: "timeout" },
    { table: "x_a", column: "amount" },
    { table: "x_a", column: "weird" },
    { table: "b", column: "size" },
  ]);
});

test("modelColumns: file rỗng / không có model → []", () => {
  assert.deepEqual(modelColumns(""), []);
  assert.deepEqual(modelColumns("export const x = 1;"), []);
});

const mig = (...sql) => [{ file: "Migration1.ts", sql }];

test("checkUnits: cột thiếu hậu tố ở migration và model đều bị báo, một dòng cho mỗi cột", () => {
  const { violations, problems } = checkUnits({
    migrations: mig(`create table "x_job" ("id" text, "timeout" integer, "ok_ms" integer);`),
    models: [
      {
        file: "m.ts",
        src: `export const J = model.define("job", { timeout: model.number(), ok_ms: model.number() });`,
      },
    ],
    allow: [],
  });
  assert.equal(problems.length, 0);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^job\.timeout — .*thời lượng.*migration \(integer\); model m\.ts/);
});

test("checkUnits: ngoại lệ theo `bảng.cột` và `*.cột` cho qua; mục nát hoặc hỏng bị báo", () => {
  const input = {
    migrations: mig(`create table "x_pay" ("amount" integer, "total" integer);`),
    models: [],
  };
  assert.deepEqual(
    checkUnits({ ...input, allow: [{ column: "pay.amount", reason: REASON }] }).violations.length,
    1,
  );
  assert.deepEqual(
    checkUnits({
      ...input,
      allow: [
        { column: "*.amount", reason: REASON },
        { column: "pay.total", reason: REASON },
      ],
    }),
    { violations: [], problems: [] },
  );
  const stale = checkUnits({
    ...input,
    allow: [
      { column: "*.amount", reason: REASON },
      { column: "pay.total", reason: REASON },
      { column: "gone.timeout", reason: REASON },
    ],
  });
  assert.match(stale.problems.join("\n"), /gone\.timeout.*không khớp/);
  const bad = checkUnits({
    ...input,
    allow: [
      { column: "pay.amount", reason: "ngắn" },
      { column: "Pay.Amount", reason: REASON },
      { column: "pay.total", reason: REASON },
      { column: "pay.total", reason: REASON },
      null,
    ],
  });
  const text = bad.problems.join("\n");
  assert.match(text, /allowlist\[0\].*thiếu "reason"/);
  assert.match(text, /allowlist\[1\].*dạng/);
  assert.match(text, /allowlist\[3\].*trùng/);
  assert.match(text, /allowlist\[4\].*dạng/);
});

test("applyColumns: drop table xoá cột (kể cả nhiều bảng, if exists); rename to chuyển cột sang tên mới", () => {
  const cols = applyColumns([
    `create table "x_a" ("delay" integer); create table "x_b" ("wait" integer); create table "x_c" ("lease" integer);`,
    `drop table if exists "x_a", "x_b" cascade;`,
    `alter table "x_c" rename to "x_d";`,
  ]);
  assert.deepEqual([...cols.keys()], ["x_d.lease"]);
  assert.equal(cols.get("x_d.lease").table, "x_d");
});

test("checkUnits: bảng đã drop hoặc đổi tên không để lại vi phạm/ngoại lệ ma", () => {
  const { violations, problems } = checkUnits({
    migrations: [
      {
        file: "Migration1.ts",
        sql: [`create table "x_old" ("delay" integer); create table "x_gone" ("wait" integer);`],
      },
      { file: "Migration2.ts", sql: [`drop table "x_gone"; alter table "x_old" rename to "x_new";`] },
    ],
    models: [],
    allow: [{ column: "new.delay", reason: REASON }],
  });
  assert.deepEqual({ violations, problems }, { violations: [], problems: [] });
});

test("checkUnits: cột đã đổi tên có hậu tố thì sạch; cột bị drop không bị báo", () => {
  const { violations } = checkUnits({
    migrations: [
      { file: "Migration1.ts", sql: [`create table "x_t" ("delay" integer, "wait" integer);`] },
      {
        file: "Migration2.ts",
        sql: [`alter table "x_t" rename column "delay" to "delay_ms", drop column "wait";`],
      },
    ],
    models: [],
    allow: [],
  });
  assert.deepEqual(violations, []);
});

test("main: repo thật đạt (migration + model + ngoại lệ khớp), mã 0", async () => {
  assert.equal(await main(join(here, ".."), quiet), 0);
});

test("main: cây có cột vi phạm → 1; allowlist hỏng/không đọc được → 2; migration không phân tích được → 2", async () => {
  const base = mkdtempSync(join(tmpdir(), "check-units-"));
  const write = (rel, content) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  };
  const out = [];
  const log = { log: (m) => out.push(m), error: (m) => out.push(m) };

  assert.equal(await main(base, log), 2, "thiếu allowlist");
  write("scripts/units-allowlist.json", "[]");
  write(
    "apps/backend/src/modules/demo/migrations/Migration20260101000000.ts",
    `import { Migration } from "@medusajs/framework/mikro-orm/migrations";
export class Migration20260101000000 extends Migration {
  async up(): Promise<void> {
    this.addSql('create table if not exists "x_demo" ("id" text not null, "lease" integer not null);');
  }
}
`,
  );
  assert.equal(await main(base, log), 1);
  assert.ok(
    out.some((l) => /demo\.lease/.test(l)),
    out.join("\n"),
  );

  write("scripts/units-allowlist.json", JSON.stringify([{ column: "demo.lease", reason: REASON }]));
  assert.equal(await main(base, log), 0);

  write("scripts/units-allowlist.json", "{}");
  assert.equal(await main(base, log), 2, "allowlist không phải mảng");

  write("scripts/units-allowlist.json", "[]");
  write(
    "apps/backend/src/modules/demo/migrations/Migration20260102000000.ts",
    `import fs from "node:fs";\nexport class M {}`,
  );
  assert.equal(await main(base, log), 2, "migration không phân tích được");
});
