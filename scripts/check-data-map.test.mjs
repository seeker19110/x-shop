import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  columnsOfMigration,
  CSV_HEADER,
  csvField,
  dataFileErrors,
  inventoryRows,
  parseCsvLine,
  reviewWarnings,
  sdkErrors,
  splitTopLevel,
  validate,
} from "./check-data-map.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const pii = (over = {}) => ({
  category: "basic",
  purpose: "giao hàng",
  legal_basis: "contract",
  retention: "r1",
  recipients: [],
  copies: "không",
  ...over,
});

function fixture() {
  const dataMap = {
    retention_classes: { r1: { rule: "x", enforced: "chưa có job", status: "đề xuất" } },
    tables: {
      t: { system: "s", pii: { phone: pii() }, non_pii: ["id"] },
    },
    external_tables: {},
  };
  const schema = new Map([["t", new Set(["id", "phone"])]]);
  const vendors = {
    vendors: [
      {
        id: "v1",
        service: "s",
        data_touched: "d",
        location: "l",
        dpa: "x",
        risk_review: "x",
        reviewed_on: "2026-10-26",
      },
    ],
  };
  const inventoryCsv =
    [CSV_HEADER, ...inventoryRows(dataMap).map((r) => r.map(csvField).join(","))].join("\n") + "\n";
  return { schema, dataMap, vendors, inventoryCsv };
}

test("fixture hợp lệ → không lỗi", () => {
  assert.deepEqual(validate(fixture()), []);
});

test("columnsOfMigration: create table (check có ngoặc/dấu phẩy), bỏ constraint, alter add column, bỏ down()", () => {
  const src = `
    export class M extends Migration {
      async up() {
        this.addSql(\`create table if not exists "a" (
          "id" text not null,
          "state" text check ("state" in ('x', 'y')) not null default 'x',
          "ghi chú" text null,
          "n" integer not null,
          constraint "a_pkey" primary key ("id"),
          constraint a_chk check (n >= 0)
        );\`);
        this.addSql(\`alter table "a" add column if not exists "extra" text null, add column if not exists "e2" int;\`);
      }
      async down() {
        this.addSql(\`drop table if exists "a";\`);
        this.addSql(\`create table if not exists "ghost" ("id" text);\`);
      }
    }`;
  const m = columnsOfMigration(src);
  assert.deepEqual([...m.keys()], ["a"]);
  // "ghi chú" có ký tự ngoài [a-z0-9_] → không nhận (tên cột quy ước ASCII); phần còn lại đủ
  assert.deepEqual([...m.get("a")].sort(), ["e2", "extra", "id", "n", "state"]);
});

test("columnsOfMigration: một dòng nhiều cột kiểu Medusa", () => {
  const src = `async up() { this.addSql(\`create table if not exists "b" ("id" text not null, "n" numeric(10,2) null, constraint "b_pkey" primary key ("id"));\`); }`;
  assert.deepEqual([...columnsOfMigration(src).get("b")], ["id", "n"]);
});

test("columnsOfMigration: nguồn rỗng → không bảng", () => {
  assert.equal(columnsOfMigration("").size, 0);
});

test("splitTopLevel: dấu phẩy trong ngoặc và nháy không cắt", () => {
  assert.deepEqual(
    splitTopLevel(`"a" text, "b" numeric(1,2), "c" text default 'x,y'`).map((s) => s.trim()),
    [`"a" text`, `"b" numeric(1,2)`, `"c" text default 'x,y'`],
  );
});

test("cột mới chưa phân loại → lỗi (ca chính: cột PII không thể lọt)", () => {
  const f = fixture();
  f.schema.get("t").add("email");
  const errs = validate(f);
  assert.ok(
    errs.some((e) => e.includes('"t.email" chưa được phân loại')),
    errs.join("\n"),
  );
});

test("bảng mới chưa khai báo → lỗi", () => {
  const f = fixture();
  f.schema.set("u", new Set(["id"]));
  assert.ok(validate(f).some((e) => e.includes('bảng "u"')));
});

test("khai báo thừa (cột/bảng không còn trong migration) → lỗi", () => {
  const f = fixture();
  f.dataMap.tables.t.non_pii.push("ghost");
  f.dataMap.tables.zombie = { system: "s", pii: {}, non_pii: [] };
  const errs = validate(f);
  assert.ok(errs.some((e) => e.includes("t.ghost")));
  assert.ok(errs.some((e) => e.includes('bảng "zombie"')));
});

test("cột vừa pii vừa non_pii → lỗi", () => {
  const f = fixture();
  f.dataMap.tables.t.non_pii.push("phone");
  assert.ok(validate(f).some((e) => e.includes("cả pii và non_pii")));
});

test("legal_basis thiếu hoặc ngoài tập → lỗi; nhạy cảm không có art9_basis → lỗi", () => {
  const f = fixture();
  f.dataMap.tables.t.pii.phone = pii({ legal_basis: "vì_thích" });
  assert.ok(validate(f).some((e) => e.includes("legal_basis")));
  delete f.dataMap.tables.t.pii.phone.legal_basis;
  assert.ok(validate(f).some((e) => e.includes("legal_basis")));
  const g = fixture();
  g.dataMap.tables.t.pii.phone = pii({ category: "sensitive" });
  assert.ok(validate(g).some((e) => e.includes("art9_basis")));
  g.dataMap.tables.t.pii.phone.art9_basis = "consent";
  g.inventoryCsv = [CSV_HEADER, ...inventoryRows(g.dataMap).map((r) => r.map(csvField).join(","))].join("\n");
  assert.deepEqual(validate(g), []);
});

test("purpose rỗng/khoảng trắng, retention không có lớp, recipients sai kiểu → lỗi", () => {
  const f = fixture();
  f.dataMap.tables.t.pii.phone = pii({
    purpose: "   ",
    retention: "không_có",
    recipients: "ghn",
    copies: "",
  });
  const errs = validate(f).join("\n");
  assert.match(errs, /thiếu purpose/);
  assert.match(errs, /không có trong retention_classes/);
  assert.match(errs, /recipients phải là mảng/);
  assert.match(errs, /thiếu copies/);
});

test("recipients trỏ nhà cung cấp chưa có trong vendors.yaml → lỗi", () => {
  const f = fixture();
  f.dataMap.tables.t.pii.phone = pii({ recipients: ["ghn"] });
  assert.ok(validate(f).some((e) => e.includes('"ghn" không có trong')));
});

test("inventory: thiếu dòng, thừa dòng, lệch nội dung, trùng, sai header/số trường → lỗi", () => {
  const f = fixture();
  const row = inventoryRows(f.dataMap)[0];
  const csv = (rows, header = CSV_HEADER) => [header, ...rows].join("\n");
  assert.ok(validate({ ...f, inventoryCsv: csv([]) }).some((e) => e.includes("thiếu cột PII t.phone")));
  assert.ok(
    validate({ ...f, inventoryCsv: csv([row.map(csvField).join(","), "s,t,zzz,basic,p,contract,r1"]) }).some(
      (e) => e.includes("t.zzz"),
    ),
  );
  const drift = [...row];
  drift[4] = "mục đích khác";
  assert.ok(
    validate({ ...f, inventoryCsv: csv([drift.map(csvField).join(",")]) }).some((e) =>
      e.includes("lệch data-map"),
    ),
  );
  const same = row.map(csvField).join(",");
  assert.ok(validate({ ...f, inventoryCsv: csv([same, same]) }).some((e) => e.includes("trùng dòng")));
  assert.ok(validate({ ...f, inventoryCsv: csv([same], "a,b") }).some((e) => e.includes("dòng đầu")));
  assert.ok(validate({ ...f, inventoryCsv: csv([same, "x,y"]) }).some((e) => e.includes("sai số trường")));
  assert.ok(validate({ ...f, inventoryCsv: "" }).some((e) => e.includes("dòng đầu")));
});

test("CSV: trường có dấu phẩy, nháy kép và Unicode đi vòng đúng", () => {
  const vals = ["a,b", 'nói "xin chào"', "Đơn hàng — Đà Nẵng", ""];
  const line = vals.map(csvField).join(",");
  assert.deepEqual(parseCsvLine(line), vals);
});

test("vendors.yaml thiếu trường bắt buộc → lỗi", () => {
  const f = fixture();
  delete f.vendors.vendors[0].dpa;
  assert.ok(validate(f).some((e) => e.includes('"v1" thiếu "dpa"')));
});

test("external_tables: legal_basis/retention/recipients sai → lỗi; khoá `_note` bị bỏ qua", () => {
  const f = fixture();
  f.dataMap.external_tables = {
    _note: "x",
    order_address: { pii_columns: ["phone"], legal_basis: "contract", retention: "r1", recipients: [] },
  };
  assert.deepEqual(validate(f), []);
  f.dataMap.external_tables.order_address = {
    pii_columns: [],
    legal_basis: "x",
    retention: "zz",
    recipients: ["q"],
  };
  const errs = validate(f).join("\n");
  assert.match(errs, /external_tables.order_address: legal_basis/);
  assert.match(errs, /retention "zz"/);
  assert.match(errs, /thiếu pii_columns/);
  assert.match(errs, /recipients "q"/);
});

test("sdkErrors: SDK dịch vụ chưa khai bị chặn; đã khai hoặc thư viện thường thì qua; Medusa admin-sdk không bị nhầm", () => {
  const manifests = [
    {
      file: "apps/backend/package.json",
      deps: ["zod", "@medusajs/admin-sdk", "twilio", "@sendgrid/mail", "@aws-sdk/client-s3"],
    },
  ];
  const errs = sdkErrors(manifests, { vendors: [{ id: "x", packages: ["twilio"] }] });
  assert.equal(errs.length, 2);
  assert.ok(
    errs.some((e) => e.includes("@sendgrid/mail")) && errs.some((e) => e.includes("@aws-sdk/client-s3")),
  );
  assert.deepEqual(sdkErrors([{ file: "p", deps: [] }], {}), []);
  assert.ok(
    sdkErrors([{ file: "p", deps: ["@medusajs/notification-sendgrid"] }], { vendors: [] }).length === 1,
  );
});

test("dataFileErrors: > 1 MB, CSV có cột PII; ngưỡng biên đúng 1 MB qua; đuôi khác bỏ qua", () => {
  const MB = 1024 * 1024;
  assert.deepEqual(dataFileErrors([{ path: "a.sql", size: MB }]), []);
  assert.equal(dataFileErrors([{ path: "a.sql", size: MB + 1 }]).length, 1);
  assert.equal(dataFileErrors([{ path: "big.txt", size: 10 * MB }]).length, 0);
  assert.equal(dataFileErrors([{ path: "d.csv", size: 10, firstLine: "id,Phone,total" }]).length, 1);
  assert.equal(dataFileErrors([{ path: "d.csv", size: 10, firstLine: "id,total" }]).length, 0);
  assert.equal(dataFileErrors([{ path: "d.csv", size: 10, firstLine: "id,customer_email" }]).length, 1);
  assert.equal(dataFileErrors([{ path: "d.csv", size: 0, firstLine: "" }]).length, 0);
});

test("reviewWarnings: changelog quá 183 ngày, vendor quá 12 tháng, ngày sai, không có mục", () => {
  const today = new Date("2026-10-26T00:00:00Z");
  const vendors = {
    vendors: [
      { id: "old", reviewed_on: "2025-01-01" },
      { id: "bad", reviewed_on: "hôm qua" },
      { id: "ok", reviewed_on: "2026-10-01" },
    ],
  };
  const w = reviewWarnings({ vendors, changelogText: "## 2026-01-01\n- x", today });
  assert.equal(w.length, 3);
  assert.ok(
    w.some((x) => x.includes("183")) &&
      w.some((x) => x.includes('"old"')) &&
      w.some((x) => x.includes('"bad"')),
  );
  assert.equal(reviewWarnings({ vendors: { vendors: [] }, changelogText: "## 2026-10-20", today }).length, 0);
  assert.equal(reviewWarnings({ vendors: { vendors: [] }, changelogText: "", today }).length, 1);
});

test("chạy trên repo thật: đạt (exit 0)", () => {
  const r = spawnSync(process.execPath, [join(here, "check-data-map.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /đạt/);
});
