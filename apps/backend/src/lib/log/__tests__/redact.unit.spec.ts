import { inspect } from "node:util";
import { knex } from "@medusajs/framework/mikro-orm/knex";
import { isSensitiveKey, MAX_TEXT, REDACTED, redactLog, redactText, shortHash } from "../redact";

/**
 * ReDoS (review T-090): đầu vào đối nghịch 32K ký tự cho TỪNG mẫu phải xong nhanh. Trần 50 ms CPU/lần (máy CI chậm vẫn dư —
 * bản regex mở cũ mất 300–450 ms với 16K ký tự cho riêng mẫu email).
 */
describe("hiệu năng đầu vào đối nghịch (chống ReDoS)", () => {
  const N = 32_000;
  const cases: [string, string][] = [
    ["email: chữ không @", "a".repeat(N)],
    ["email: nhiều @ không tên miền", "a@".repeat(N / 2)],
    ["email: tên miền dài không TLD", `a@${"b".repeat(N)}`],
    ["email: chấm lặp", `${"a.".repeat(N / 2)}@`],
    ["URL: scheme dài không ://", "a".repeat(N) + ":"],
    ["URL: :// không @", `http://${":".repeat(N)}`],
    ["Bearer lặp", "Bearer ".repeat(N / 7)],
    ["JWT: eyJ lặp", "eyJ".repeat(N / 3)],
    ["key=value: khoảng trắng dài", `token${" ".repeat(N)}x`],
    ["key=value: nháy không đóng", `password="${"a".repeat(N)}`],
    ["số dài (thẻ/CCCD/SĐT)", "1".repeat(N)],
    ["số tách nhóm", "0 ".repeat(N / 2)],
    ["địa chỉ: số + khoảng trắng", `1${" ".repeat(N)}x`],
    ["địa chỉ: 1/1/1…", `${"1/".repeat(N / 2)} đường`],
    ["địa chỉ: phẩy lặp", "Phường A,".repeat(N / 9)],
    ["SQL: nháy lặp", `insert into x values (${"'',".repeat(N / 3)}`],
    ["SQL: select dài", `select ${"a ".repeat(N / 2)}`],
    ["OTP: chữ lặp", "otp ".repeat(N / 4)],
    ["Key ()=( lặp", "Key (".repeat(N / 5)],
    ["SQL: literal dài + nháy", `insert into "t" values (${"'a".repeat(N / 2)}`],
    ["SQL: chỉ nháy", `insert into "t" ${"'".repeat(N)}`],
    ["SELECT viết hoa lặp", "SELECT ".repeat(N / 7)],
    ["cụm số + Tên", ", 1 Ab".repeat(N / 6)],
    ["address= lặp", "address=".repeat(N / 8)],
    ["SQL knex: insert lặp không ' - '", 'insert into "t" '.repeat(N / 16)],
    ["SQL knex: insert + stack lặp", 'insert into "t" values (1)\n    at x '.repeat(N / 36)],
    ["SQL knex: update set lặp", 'update "t" set '.repeat(N / 15)],
    ["SQL knex: ' - ' lặp", `insert into "t" values (${"1 - ".repeat(N / 4)}`],
    ["SQL knex: select where lặp", 'select a from "t" where '.repeat(N / 24)],
    ["SQL knex: select không where", `select ${"a ".repeat(N / 4)} from "t"`],
    ["SQL knex: INSERT INTO HOA lặp", "INSERT INTO t ".repeat(N / 14)],
    ["SQL knex: insert into trần lặp", "insert into a (".repeat(N / 15)],
    ["SQL knex: select from trần lặp", "select a from b where ".repeat(N / 22)],
    ["SQL knex: update trần lặp", "update a set b = ".repeat(N / 17)],
    ["SQL knex: INSERT INTO + xuống dòng + at lặp", "INSERT INTO t (a)\n  at ".repeat(N / 21)],
    ["SQL knex: nháy lẻ + at lặp", "insert into t (a) values ('\n    at ".repeat(N / 35)],
    ["SQL knex: delete from lặp", 'delete from "t" '.repeat(N / 16)],
    // Review T-151 vòng 2: ứng viên select bị loại không được quét lại vùng (bản cũ: 130 ms CPU với 32K).
    ["SQL knex: select from nháy lặp, không where", 'select a from "t" '.repeat(N / 18)],
    ["SQL knex: select join lặp", 'select a from "t" join "u" on '.repeat(N / 30)],
    ["SQL knex: select from trần lặp (bị loại)", "select a from b ".repeat(N / 16)],
    ["SQL knex: select + stack lặp", 'select 1 from "t"\n    at '.repeat(N / 25)],
    ["SQL knex: delete using lặp", 'delete from "t" using '.repeat(N / 22)],
    ["SQL knex: update alias lặp", 'update "t" as "x" set '.repeat(N / 22)],
    ["SQL knex: dollar-quote lặp", 'insert into "t" ($$'.repeat(N / 19)],
    ["SQL knex: dollar-tag không đóng lặp", 'insert into "t" ($a$ - '.repeat(N / 23)],
    ["SQL knex: E-string lặp", 'insert into "t" (E\'\\'.repeat(N / 20)],
    ["SQL knex: nháy kép lẻ lặp", 'insert into "t" ("\n    at '.repeat(N / 26)],
    ["SQL knex: nháy đơn + ' - ' lặp", 'insert into "t" (\' - '.repeat(N / 21)],
    ["SQL knex: select danh sách rất dài", `select ${'"p0"."c", '.repeat(N / 10)} from "t" where "h" = 1`],
  ];
  it.each(cases)("%s → < 50 ms", (_name, input) => {
    redactText(input.slice(0, 100)); // làm nóng regex
    // Thời gian CPU (không phải wall-clock): cổng chạy song song nhiều tiến trình làm wall-clock vượt trần dù regex
    // không backtrack (63 ms khi máy tải nặng); backtracking thảm hoạ vẫn tốn hàng trăm ms CPU nên vẫn bị bắt.
    const t0 = process.cpuUsage();
    redactText(input);
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });
});

describe("địa chỉ/họ tên trong nháy, SQL, JSON, util.inspect (review T-090)", () => {
  it("lỗi knex có câu INSERT kèm giá trị → mọi literal trong nháy bị che", () => {
    const msg =
      'insert into "customer_address" ("first_name", "last_name", "address_1", "city") values (\'An\', \'Nguyễn\', \'25/3 hẻm 12 Lê Văn Sỹ\', \'Phường 13, Quận 3\') - duplicate key value';
    const out = redactText(msg);
    expect(out).not.toMatch(/An'|Nguyễn|Lê Văn Sỹ|Phường 13/);
    // T-151: cả danh sách giá trị bị bỏ (không chỉ chuỗi) — còn động từ + bảng + lỗi.
    expect(out).toBe(`insert into "customer_address" ${REDACTED} - duplicate key value`);
    expect(shortHash("An")).toMatch(/^\[h:[0-9a-f]{8}\]$/);
  });

  it("chi tiết ràng buộc Postgres `Key (...)=(...)` → băm ngắn từng giá trị (còn đối chiếu được)", () => {
    expect(redactText("Key (phone, name)=(0912345678, Trần B) already exists.")).toBe(
      `Key (phone, name)=(${shortHash("0912345678")}, ${shortHash("Trần B")}) already exists.`,
    );
    expect(redactText("Key (idempotency_key)=(idem_01JABCDEF) already exists.")).toBe(
      `Key (idempotency_key)=(${shortHash("idem_01JABCDEF")}) already exists.`,
    );
  });

  it("literal SQL dài hơn 4096 ký tự không làm lệch cặp nháy (không lộ họ tên phía sau)", () => {
    const out = redactText(`insert into "a" ("x", "y", "z") values ('${"x".repeat(5000)}', 'An', 'Nguyễn')`);
    expect(out).not.toMatch(/'An'|Nguyễn|xxxx/);
  });

  it('địa chỉ sau khoá address= / "address":"…" vẫn bị che', () => {
    expect(redactText(`{"address":"12 Nguyễn Trãi","city":"HCM"}`)).toBe(
      `{"address":"${REDACTED}","city":"HCM"}`,
    );
    expect(redactText("address=12 Lê Lợi&x=1")).toBe(`address=${REDACTED}&x=1`);
    expect(redactText("first_name: 'Lan'")).toBe(`first_name: '${REDACTED}'`);
  });

  it.each([
    "size=38 Đỏ, còn:12 Áo Thun",
    "giao lúc 10:30 Chiều, kho 3 Hà Nội",
    "[checkout] giữ hàng: variant=variant_01J qty=2 Áo, warehouse=Kho 1 Hà Nội",
    "Đơn XS-1001: 2 Áo Thun, 1 Quần Jean",
    "Allowed values ('draft', 'published') for status",
    "update cart set: 'promo' applied",
    "Please select a size from the list: 'M'",
    "status changed: 'pending' -> 'captured' (amount 1250000)",
    "Bật 2fa 2026-10-26 cho user_01J",
    "otp_window=1 totp period=30",
    "vnp_TxnRef=PA_01JABC vnp_Amount=125000000 vnp_ResponseCode=00 vnp_PayDate=20261026103000",
    'GHN order_code=GYH7XKPQ status=delivering to_ward_code="21012" fee=30000',
    "Không tìm thấy biến thể 'AO-THUN-38-DO' trong kho 'WH-HN'",
  ])("không che nhầm (review): %j", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it("JSON.stringify / util.inspect của object địa chỉ (khoá lạ) → địa chỉ bị che", () => {
    const addr = { line: "12 Nguyễn Trãi", ward: "Phường Bến Thành", district: "Quận 1" };
    for (const text of [JSON.stringify(addr), inspect(addr)]) {
      const out = redactText(`lỗi giao hàng: ${text}`);
      expect(out).not.toMatch(/Nguyễn Trãi|Bến Thành/);
    }
    expect(redactText(`addr='12 Nguyễn Trãi, Phường Bến Thành'`)).not.toMatch(/Nguyễn Trãi|Bến Thành/);
    expect(redactText(`"25/3 hẻm 12 Lê Văn Sỹ"`)).not.toContain("Lê Văn Sỹ");
  });

  it("câu SELECT có literal; thông điệp thường có nháy không bị che nhầm", () => {
    expect(redactText("select * from \"order\" where \"email\" = 'x' and name = 'Lan'")).not.toContain("Lan");
    expect(redactText("không tìm thấy sản phẩm 'ao-thun'")).toBe("không tìm thấy sản phẩm 'ao-thun'");
  });
});

describe("giá trị bind trong lỗi SQL của knex/pg (T-151)", () => {
  const INSERT =
    `insert into "fashion_model_measurement" ("id", "model_id", "height_cm", "bust_cm", "waist_cm", "hip_cm", "note", "extra", "deleted_at") ` +
    `values ('fmm_01J', 'mdl_01J', 180, 94, 78, 95, 'Nguyễn Văn A - 0912345678', '{"weight":61.5,"k":[1,2]}', null) - boom trigger`;

  it("insert: không còn số/chuỗi/JSON/null; giữ động từ + bảng + lỗi", () => {
    const out = redactText(INSERT);
    expect(out).toBe(`insert into "fashion_model_measurement" ${REDACTED} - boom trigger`);
    expect(out).not.toMatch(/180|94|78|95|61\.5|Nguyễn|0912345678|fmm_01J/);
  });

  it("update … set … where …: bỏ giá trị và điều kiện", () => {
    expect(
      redactText(
        `update "customer" set "weight_kg" = 61, "note" = 'a - b', "x" = null where "id" = 'c_1' and "age" = 33 - deadlock detected`,
      ),
    ).toBe(`update "customer" set ${REDACTED} - deadlock detected`);
  });

  it("delete from … where …", () => {
    expect(
      redactText(`delete from "cart" where "total" = 1500000 and "id" in ('a', 'b') - fk violation`),
    ).toBe(`delete from "cart" ${REDACTED} - fk violation`);
  });

  it("select … where có literal: bỏ danh sách chọn và mọi thứ sau bảng đầu tiên", () => {
    expect(
      redactText(
        `select "o".* from "order" as "o" where "o"."total" = 250000 and "o"."note" is not null limit 1 - timeout`,
      ),
    ).toBe(`select ${REDACTED} from "order" ${REDACTED} - timeout`);
  });

  it("SQL viết thường, định danh không nháy (knex.raw/migration)", () => {
    expect(redactText("insert into t_m (id, h) values ('x', 180) - boom")).toBe(
      `insert into t_m ${REDACTED} - boom`,
    );
    expect(redactText("update t_m set h = 180, n = null where id = 'x' - boom")).toBe(
      `update t_m set ${REDACTED} - boom`,
    );
    expect(redactText("delete from t_m where h = 180 - boom")).toBe(`delete from t_m ${REDACTED} - boom`);
    expect(redactText("select * from t_m where h = 180 and w = 61 - boom")).toBe(
      `select ${REDACTED} from t_m ${REDACTED} - boom`,
    );
  });

  it("SQL viết hoa không nháy định danh", () => {
    expect(redactText("INSERT INTO t (a, b) VALUES (1, 2) - boom")).toBe(`INSERT INTO t ${REDACTED} - boom`);
  });

  it("phần lỗi chứa ' - ': cắt tại ' - ' CUỐI, giá trị trước đó vẫn bỏ", () => {
    const out = redactText(`insert into "t" ("a") values (777 - 1) - relation x - does not exist`);
    expect(out).toBe(`insert into "t" ${REDACTED} - does not exist`);
  });

  it("không có ' - ': bỏ tới hết vùng (an toàn hơn giữ)", () => {
    expect(redactText(`insert into "t" ("a") values (777)`)).toBe(`insert into "t" ${REDACTED}`);
  });

  it("giữ tiền tố và stack: `error: insert …` + dòng `at`; câu thứ hai ở Caused by cũng che", () => {
    const text = `error: insert into "t" ("h") values (180) - boom\n    at parse (/x/y.js:1:1)\nCaused by: error: update "t" set "h" = 94 - again\n    at z (/z.js:2:2)`;
    expect(redactText(text)).toBe(
      `error: insert into "t" ${REDACTED} - boom\n    at parse (/x/y.js:1:1)\nCaused by: error: update "t" set ${REDACTED} - again\n    at z (/z.js:2:2)`,
    );
  });

  it("Error: message, stack, util.inspect và JSON.stringify đều không còn số đã chèn", () => {
    const err = new Error(INSERT);
    err.stack = `error: ${INSERT}\n    at parse (/x/y.js:1:1)`;
    for (const text of [JSON.stringify(redactLog(err)), inspect(redactLog(err), { depth: 6 })]) {
      expect(text).not.toMatch(/180|94|78|95|61\.5|Nguyễn|0912345678/);
      expect(text).toContain("boom trigger");
    }
  });

  it('review 1: object đã JSON.stringify (`\\"` thoát nháy) vẫn nhận ra câu SQL', () => {
    const err = { message: INSERT, name: "error" };
    const out = redactText(JSON.stringify(err));
    expect(out).not.toMatch(/180|9431|Nguyễn|0912345678|fmm_01J/);
    expect(out).toContain("boom trigger");
    expect(JSON.stringify(redactLog(err))).not.toMatch(/180|9431|Nguyễn|0912345678/);
  });

  it("review 2: select không where không nuốt câu sau (Caused by), danh sách chọn có số bị bỏ", () => {
    const text =
      `select "id" from "cart" limit 1 - boom\n    at x (/a.js:1:1)\nCaused by: error: insert into "t" ("a") values (9431, 180) - dup\n` +
      `    at y (/b.js:1:1)\nCaused by: error: delete from "u" where "id" = 5 - z`;
    const out = redactText(text);
    expect(out).not.toMatch(/9431|180|"id" = 5/);
    expect(out).toContain(`select ${REDACTED} from "cart" ${REDACTED} - boom\n    at x (/a.js:1:1)`);
    expect(out).toContain("- dup");
    expect(out).toContain("- z");
    expect(redactText(`select 9431 as h from "t" - boom`)).toBe(`select ${REDACTED} from "t" - boom`);
    expect(redactText(`select "id" from "t" where "n" = 5 - boom`)).toBe(
      `select ${REDACTED} from "t" ${REDACTED} - boom`,
    );
  });

  it("review 3: `\\n    at` nằm TRONG literal không cắt vùng (không lộ số phía sau)", () => {
    const out = redactText(`insert into "t" ("a","b","c") values ('a\n    at b', 9431, 180) - boom`);
    expect(out).toBe(`insert into "t" ${REDACTED} - boom`);
  });

  it("review 4: giảm báo nhầm — câu văn không bị che; Caused by không dòng at giữ lỗi đầu", () => {
    for (const t of [
      "Failed to select products from catalog where price is high - retry later - code 42",
      'Insert into "orders" failed: unique violation',
      "select the best from list where possible",
    ]) {
      expect(redactText(t)).toBe(t);
    }
    expect(
      redactText(
        `insert into "t" ("a") values (1) - boom1\nCaused by: error: insert into "t" ("a") values (2) - boom2`,
      ),
    ).toBe(`insert into "t" ${REDACTED} - boom1\nCaused by: error: insert into "t" ${REDACTED} - boom2`);
  });

  describe("review vòng 2: bỏ toàn bộ thân câu, không phân tích mệnh đề", () => {
    it("🟠2 danh sách cột rất dài (MikroORM) vẫn che điều kiện", () => {
      const cols = Array.from({ length: 90 }, (_, i) => `"f0"."column_name_${i}"`).join(", ");
      expect(cols.length).toBeGreaterThan(2048);
      const out = redactText(
        `select ${cols} from "fashion_model_measurement" as "f0" where "f0"."height_cm" = 173 - canceling statement due to statement timeout`,
      );
      expect(out).toBe(
        `select ${REDACTED} from "fashion_model_measurement" ${REDACTED} - canceling statement due to statement timeout`,
      );
    });

    it.each([
      [`delete from "t" using "u" where "u"."x" = 9431 - boom`, `delete from "t" ${REDACTED} - boom`],
      [`delete from "t" as "x" where "x"."h" = 9431 - boom`, `delete from "t" as "x" ${REDACTED} - boom`],
      [`update "t" as "x" set "a" = 9431 - boom`, `update "t" as "x" set ${REDACTED} - boom`],
      [
        `select "a" from "t" inner join "u" on "u"."id" = "t"."id" and "u"."h" = 9431 - boom`,
        `select ${REDACTED} from "t" ${REDACTED} - boom`,
      ],
      [`select * from "t" limit 9431 - boom`, `select ${REDACTED} from "t" ${REDACTED} - boom`],
      [`select * from "t" offset 9431 - boom`, `select ${REDACTED} from "t" ${REDACTED} - boom`],
      [`select "id" from "t" - boom`, `select ${REDACTED} from "t" - boom`],
      // 🟢5 SQL viết tay: E-string, dollar-quote (có/không tag), định danh chứa `'`.
      [
        `insert into "t" ("a","b") values (E'x\\' - y\n    at z', 9431) - boom`,
        `insert into "t" ${REDACTED} - boom`,
      ],
      [`insert into "t" ("a","b") values (E'a''b\\\\', 9431) - boom`, `insert into "t" ${REDACTED} - boom`],
      [
        `insert into "t" ("a","b") select $$x - y\n    at q$$, 9431 - boom`,
        `insert into "t" ${REDACTED} - boom`,
      ],
      [`insert into "t" ("a","b") select $q$x' - $$ y$q$, 9431 - boom`, `insert into "t" ${REDACTED} - boom`],
      [`insert into "t" ("o'x", "h") values ('a - b', 9431) - boom`, `insert into "t" ${REDACTED} - boom`],
      // `$1` (tham số) không phải dollar-quote.
      [`update "t" set "h" = $1 where "id" = $2 - boom`, `update "t" set ${REDACTED} - boom`],
    ])("%j → %j", (input, expected) => {
      expect(redactText(input)).toBe(expected);
    });

    it("dollar-quote không đóng → bỏ tới hết (đóng an toàn)", () => {
      const out = redactText(`insert into "t" ("a") select $$x - y, 9431 - boom\n    at f (/a.js:1:1)`);
      expect(out).toBe(`insert into "t" ${REDACTED}`);
    });

    it("`from` nằm trong literal của danh sách chọn → không giữ làm tên bảng", () => {
      const out = redactText(`select 'Nguyen from "Ha Noi"' as n from "t" where "h" = 173 - boom`);
      expect(out).not.toMatch(/Nguyen|Ha Noi|173/);
      // `from` kế tiếp nằm trong literal → bỏ cả tên bảng (an toàn hơn đoán).
      expect(out).toBe(`select ${REDACTED} - boom`);
    });

    it("câu do knex sinh với giá trị đối nghịch (nháy, \\, ' - ', xuống dòng + at, Caused by) không lộ số", () => {
      const db = knex({ client: "pg" });
      const evil = [
        "x\\' - y\n    at z",
        "a'' - b\n    at c",
        "o'brien - x\nCaused by: y",
        "back\\\\ - q\n  at r",
        "$$ - $q$",
      ];
      for (const note of evil) {
        const sqls = [
          db("t").insert({ note, h: 9431, w: 180 }).toString(),
          db("t").update({ note, h: 9431 }).where({ id: "abc-777" }).toString(),
          db("t").where({ note, h: 9431 }).del().toString(),
          db("t").select("a").where({ note }).andWhere("h", 9431).limit(180).toString(),
          db("t as x")
            .join("u", "u.id", "x.id")
            .where("u.h", 9431)
            .andWhere({ note })
            .select("x.a")
            .toString(),
        ];
        for (const sql of sqls) {
          const out = redactText(`error: ${sql} - boom\n    at f (/a.js:1:1)`);
          expect(out).not.toMatch(/9431|180|abc-777|brien|back/);
          expect(out).toMatch(/ - boom\n {4}at f \(\/a\.js:1:1\)$/);
        }
      }
      void db.destroy();
    });

    it("thuộc tính (seed cố định, 400 ca): giá trị do client điều khiển ghép từ ký tự đặc biệt không làm lộ số qua knex", () => {
      const db = knex({ client: "pg" });
      const atoms = [
        "'",
        "''",
        '"',
        "\\",
        "\\'",
        " - ",
        "$$",
        "$a$",
        "E'",
        "\n    at x",
        "\nCaused by: y",
        "\n",
        " ",
        "a",
        "(",
        ")",
      ];
      let seed = 151;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };
      for (let k = 0; k < 400; k++) {
        const note = Array.from({ length: 1 + rnd(12) }, () => atoms[rnd(atoms.length)]).join("");
        const sql = [
          () => db("t").insert({ note, h: 9431 }).toString(),
          () => db("t").update({ note, h: 9431 }).where({ id: 7 }).toString(),
          () => db("t").where({ note }).andWhere("h", 9431).del().toString(),
          () => db("t").select("a").where({ note }).andWhere("h", 9431).toString(),
        ][k % 4]!();
        const out = redactText(`${sql} - boom\n    at f (/a.js:1:1)`);
        expect([note, out]).toEqual([note, expect.not.stringMatching(/9431/)]);
        expect(out.endsWith(" - boom\n    at f (/a.js:1:1)")).toBe(true);
      }
      void db.destroy();
    });

    it("chạy lại trên đầu ra không đổi gì (idempotent — logger che hai lần: describeError rồi message)", () => {
      for (const t of [
        `select "a" from "t" where "h" = 1 - boom`,
        `insert into "t" ("a") values (1) - boom`,
        `update "t" as "x" set "a" = 1 - boom`,
        `delete from "t" using "u" where "u"."x" = 1 - boom`,
      ]) {
        const once = redactText(t);
        expect(redactText(once)).toBe(once);
        expect(redactText(JSON.stringify({ message: t }))).toBe(JSON.stringify({ message: once }));
      }
    });

    it("gọi xen kẽ nhiều đầu vào cho kết quả như gọi riêng (regex dùng chung không giữ trạng thái lastIndex)", () => {
      const inputs = [
        `select "a" from "t" where "h" = 1 - boom`,
        "không tìm thấy sản phẩm 'ao-thun'",
        `update "t" set "a" = 2 - x\nCaused by: error: delete from "u" where "id" = 3 - y`,
        "select the items from the list where possible",
        `insert into "t" ("a") values ($$a$$, 4) - z`,
      ];
      const alone = inputs.map((t) => redactText(t));
      const mixed = [...inputs, ...[...inputs].reverse()].map((t) => redactText(t));
      expect(mixed.slice(0, inputs.length)).toEqual(alone);
      expect(mixed.slice(inputs.length)).toEqual([...alone].reverse());
    });

    it("câu văn vẫn giữ nguyên (không nhận nhầm là SQL)", () => {
      for (const t of [
        "Please select an option from the menu - then retry",
        'update the "cart" set of rules - later',
        "delete from cart failed with 500",
      ]) {
        expect(redactText(t)).toBe(t);
      }
    });
  });

  it("không đụng văn bản thường nhắc update/insert/select/delete", () => {
    for (const t of [
      "please update the set of items - done",
      "insert into the queue - ok",
      "select the items from the list where possible",
      "delete from cart failed with 500",
      "",
    ]) {
      expect(redactText(t)).toBe(t);
    }
  });
});

describe("khoá API tiền tố và mã OTP/MFA (review T-090)", () => {
  it.each([
    ["key sk_live_51HxYzAbCdEfGh123456", `key ${REDACTED}`],
    ["pk_test_abcdefgh12", REDACTED],
    ["whsec_abcdefghijk", REDACTED],
    [`key sk_${"0a".repeat(32)}`, `key ${REDACTED}`],
    [`pk_${"f1".repeat(16)}`, REDACTED],
    ["otp 123456", `otp ${REDACTED}`],
    ["mfa code=654321", `mfa code=${REDACTED}`],
    ["Mã OTP: 112233", `Mã OTP: ${REDACTED}`],
    ["recovery_code 12345678", `recovery_code ${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("không che mã HTTP / mã lỗi thường", () => {
    expect(redactText("status 404 code 500")).toBe("status 404 code 500");
  });
});

/**
 * T-090 — bộ che log (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008/010): theo tên trường + theo nội dung, bộ mẫu PII tiếng
 * Việt (SĐT, CCCD 12 số, email, địa chỉ có dấu/không dấu) và ca không được che nhầm.
 */

describe("che theo tên trường", () => {
  it.each([
    "password",
    "newPassword",
    "token",
    "access_token",
    "refreshToken",
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "api_key",
    "x-api-key",
    "apiKey",
    "client_secret",
    "VNPAY_HASH_SECRET",
    "vnp_SecureHash",
    "DATABASE_URL",
    "redis_url",
    "session",
    "sid",
    "otp",
    "recovery_code",
    "card_number",
    "cvv",
    "AUTH_MFA_ENCRYPTION_KEY",
    "email",
    "customer_email",
    "phone",
    "phone_number",
    "sdt",
    "so_dien_thoai",
    "address_1",
    "dia_chi",
    "cccd",
    "national_id",
    "full_name",
    "first_name",
    "date_of_birth",
  ])("%s → che", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "shipping",
    "company",
    "inside",
    "span_id",
    "trace_id",
    "status_code",
    "order_id",
    "display_ref",
    "message",
    "province_code",
    "event",
    "duration_ms",
    "",
  ])("%s → giữ", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it("che cả object/mảng dưới khoá nhạy cảm; lồng sâu và trong mảng; không đổi đầu vào", () => {
    const input = {
      order_id: "XS-ABC123",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
      customer: { email: "a@example.test", phone: "0912345678", address: { line: "12 Lê Lợi" } },
      items: [{ sku: "AO-M", token: "t1" }],
      shipping_address: { ward: "Bến Thành" },
    };
    const snapshot = JSON.stringify(input);
    expect(redactLog(input)).toEqual({
      order_id: "XS-ABC123",
      headers: { authorization: REDACTED, "content-type": "application/json" },
      customer: { email: REDACTED, phone: REDACTED, address: REDACTED },
      items: [{ sku: "AO-M", token: REDACTED }],
      shipping_address: REDACTED,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("che theo nội dung — bộ mẫu PII tiếng Việt", () => {
  it.each([
    ["khach.hang+1@example.com", "[EMAIL]"],
    ["Liên hệ NGUYEN.VAN.A@Example.COM ngay", "Liên hệ [EMAIL] ngay"],
    ["0912345678", "[PHONE]"],
    ["SĐT 0912 345 678.", "SĐT [PHONE]."],
    ["0912.345.678", "[PHONE]"],
    ["0912-345-678", "[PHONE]"],
    ["+84 912 345 678", "[PHONE]"],
    ["+84912345678", "[PHONE]"],
    ["84912345678", "[PHONE]"],
    ["bàn 024 3826 1234", "bàn [PHONE]"],
    ["CCCD 099099012345", "CCCD [CCCD]"],
    ["001 099 012 345", "[CCCD]"],
    ["thẻ 4111 1111 1111 1111", "thẻ [CARD]"],
    ["4111111111111111", "[CARD]"],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    ["12 Nguyễn Trãi, P. Bến Thành, Q.1, TP.HCM", "[ADDRESS]"],
    ["Phường Dịch Vọng, Quận Cầu Giấy, Hà Nội", "[ADDRESS], Hà Nội"],
    ["so 5 ngo 12 lang ha, phuong lang ha, quan dong da, ha noi", "[ADDRESS], ha noi"],
    ["Số 5 ngõ 12 Láng Hạ, Đống Đa, Hà Nội", "[ADDRESS], Đống Đa, Hà Nội"],
    ["giao: 25/3 hẻm 102 Lê Văn Sỹ, phường 13, quận 3; gọi trước", "giao: [ADDRESS]; gọi trước"],
    ["Thôn 3, Xã Tân Lập, Huyện Đan Phượng", "[ADDRESS]"],
  ])("địa chỉ %j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("nhiều loại trong một thông điệp", () => {
    const out = redactText(
      "Khách khach@example.test (0987654321, CCCD 099203001234) giao 12 Lê Lợi, Phường Bến Nghé, Quận 1",
    );
    expect(out).not.toMatch(/khach@x\.vn|0987654321|099203001234|Lê Lợi|Bến Nghé/);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[CCCD]");
    expect(out).toBe("Khách [EMAIL] ([PHONE], CCCD [CCCD]) giao [ADDRESS]");
  });

  it.each([
    "Thử lại 3 Lần",
    "readiness: không sẵn sàng (database, redis)",
    "duration 0.123456789",
    "2026-10-26T10:00:00.000Z",
    "trace 123e4567-e89b-12d3-a456-426614174000",
    "order XS-ABC123 total 1500000",
    "đơn liên quan tới khuyến mãi",
    "ts 1761472800000",
    "4111111111111112",
    "[http] 404 NOT_FOUND POST /store/x/thing trace_id=r1",
    "ip 10.0.0.12:5432",
    "quận",
  ])("không che nhầm %j", (input) => {
    expect(redactText(input)).toBe(input);
  });
});

describe("che bí mật trong văn bản", () => {
  it.each([
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc", `Authorization: ${REDACTED}`],
    ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", `token ${REDACTED}`],
    ["postgres://xshop:matkhau@db:5432/x", `postgres://${REDACTED}@db:5432/x`],
    ["redis://:s3cret@cache:6379/0", `redis://${REDACTED}@cache:6379/0`],
    ["GET /cb?token=abc123&x=1", `GET /cb?token=${REDACTED}&x=1`],
    ['{"password":"p@ss word","x":1}', `{"password":"${REDACTED}","x":1}`],
    ["vnp_SecureHash=ab12cd&vnp_Amount=100", `vnp_SecureHash=${REDACTED}&vnp_Amount=100`],
    ["client_secret: 'zzz'", `client_secret: '${REDACTED}'`],
    ["Cookie=connect.sid", `Cookie=${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("không đụng `tokenizer=` hay `passport_photo_count` trong văn bản", () => {
    expect(redactText("tokenizer=fast")).toBe("tokenizer=fast");
  });
});

describe("cấu trúc", () => {
  it("vòng tham chiếu → [Circular]; tham chiếu dùng chung (không vòng) giữ nguyên", () => {
    const shared = { v: 1 };
    const a: Record<string, unknown> = { x: shared, y: shared };
    a.self = a;
    expect(redactLog(a)).toEqual({ x: { v: 1 }, y: { v: 1 }, self: "[Circular]" });
  });

  it("sâu quá 10 cấp → [Truncated]", () => {
    let deep: Record<string, unknown> = { leaf: "0912345678" };
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(redactLog(deep))).toContain("[Truncated]");
  });

  it("Error, Date, bigint, Map, hàm, symbol, null/undefined/số/boolean", () => {
    const err = Object.assign(new Error("gửi tới a@example.test thất bại"), {
      config: { headers: { authorization: "x" } },
    });
    const out = redactLog({
      err,
      at: new Date("2026-10-26T10:00:00Z"),
      bad: new Date(Number.NaN),
      big: 10n,
      m: new Map([["phone", "0912345678"]]),
      fn: () => 1,
      sym: Symbol("s"),
      n: null,
      u: undefined,
      zero: 0,
      f: false,
    }) as Record<string, unknown>;
    expect(out.err).toMatchObject({
      type: "Error",
      message: "gửi tới [EMAIL] thất bại",
      config: { headers: { authorization: REDACTED } },
    });
    expect(String((out.err as { stack: string }).stack)).not.toContain("a@example.test");
    expect(out).toMatchObject({
      at: "2026-10-26T10:00:00.000Z",
      bad: null,
      big: "10",
      m: { phone: REDACTED },
      n: null,
      zero: 0,
      f: false,
    });
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
  });

  it("chuỗi quá MAX_TEXT bị cắt, ghi số ký tự bỏ", () => {
    const out = redactText("a".repeat(MAX_TEXT + 10));
    expect(out.length).toBeLessThan(MAX_TEXT + 40);
    expect(out).toContain("[cắt 10 ký tự]");
  });

  it("chuỗi rỗng và Unicode tổ hợp không lỗi", () => {
    expect(redactText("")).toBe("");
    expect(redactText("Nguyễn")).toBe("Nguyễn");
  });
});
