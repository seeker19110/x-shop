import { randomUUID } from "node:crypto";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { Migration20261106100000 as CheckoutT186 } from "../../src/modules/checkout/migrations/Migration20261106100000";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { Migration20261106100100 as ShippingT186 } from "../../src/modules/shipping/migrations/Migration20261106100100";
import { Migration20261106100200 as ReturnsT186 } from "../../src/modules/returns/migrations/Migration20261106100200";
import { Migration20261106100300 as SettlementT186 } from "../../src/modules/settlement/migrations/Migration20261106100300";

jest.setTimeout(180 * 1000);

/**
 * T-186 (Q-22, DB-MODEL-002): cột tiền của module dự án là `bigint`; driver trả int8 dạng chuỗi nên tầng driver ép về
 * `number` có Number.isSafeInteger (src/lib/db/int8.ts, cài ở medusa-config.ts). Test khẳng định qua đường đọc THẬT
 * (service DML do MedusaService sinh, knex thô của runner) và đường lùi down() của migration.
 */

/** Cột tiền đổi sang bigint ở T-186 (bảng → cột). */
const MONEY_COLUMNS: Record<string, string[]> = {
  checkout_quote: ["total"],
  order_finance: ["total"],
  payment_attempt: ["amount"],
  payment_ledger: ["amount"],
  ops_exception: ["amount"],
  shipment: ["cod_amount", "shipping_fee", "cod_reported_amount"],
  x_refund: ["amount"],
  x_return_line: ["refund_amount"],
  x_settlement_line: ["amount"],
};

/** Lớn hơn trần int4 (2.147.483.647) — chỉ ghi được khi cột là bigint. */
const ABOVE_INT4 = 3_000_000_000;

/** pg_get_triggerdef của trigger khoá đơn khi sửa hoàn tiền (Migration20261026010000) — T-186 phải tạo lại y hệt. */
const X_REFUND_ORDER_LOCK_UPD =
  "CREATE TRIGGER x_refund_order_lock_upd BEFORE UPDATE ON public.x_refund FOR EACH ROW WHEN (((new.state <> ALL (ARRAY['rejected'::text, 'cancelled'::text])) AND ((old.state = ANY (ARRAY['rejected'::text, 'cancelled'::text])) OR (new.amount > old.amount) OR (new.order_id IS DISTINCT FROM old.order_id)))) EXECUTE FUNCTION x_refund_require_order_lock()";

const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`;

interface RawDb {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

type MigrationClass = new (
  a: never,
  b: never,
) => {
  up(): Promise<void>;
  down(): Promise<void>;
  getQueries(): unknown[];
};

medusaIntegrationTestRunner({
  testSuite: ({ dbConnection, getContainer }) => {
    const db = () => dbConnection as unknown as RawDb;
    const checkout = () => getContainer().resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const shipping = () => getContainer().resolve<ShippingModuleService>(SHIPPING_MODULE);

    const columnTypes = async (): Promise<Record<string, string>> => {
      const { rows } = await db().raw(
        `SELECT table_name || '.' || column_name AS col, data_type AS type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY(?)`,
        [Object.keys(MONEY_COLUMNS)],
      );
      const out: Record<string, string> = {};
      for (const r of rows) out[String(r.col)] = String(r.type);
      return out;
    };
    const expectAll = async (type: string) => {
      const types = await columnTypes();
      for (const [t, cols] of Object.entries(MONEY_COLUMNS))
        for (const c of cols)
          expect({ col: `${t}.${c}`, type: types[`${t}.${c}`] }).toEqual({ col: `${t}.${c}`, type });
    };
    const runMigration = async (M: MigrationClass, direction: "up" | "down") => {
      const m = new M({} as never, {} as never);
      await m[direction]();
      for (const q of m.getQueries()) await db().raw(String(q));
    };
    const insertQuote = async (total: number) => {
      const id = uid("cqt");
      await db().raw(
        `INSERT INTO checkout_quote (id, cart_id, cart_version, payment_method, address, breakdown, total, expires_at)
         VALUES (?, ?, 1, 'cod', '{}'::jsonb, '{}'::jsonb, ?, now() + interval '10 minutes')`,
        [id, uid("cart"), total],
      );
      return id;
    };
    const insertShipment = async (cod: number, fee: number | null, reported: number | null) => {
      const id = uid("shp");
      await db().raw(
        `INSERT INTO shipment (id, order_id, client_order_code, provider, cod_amount, shipping_fee, payer, created_by,
           cod_reported_amount)
         VALUES (?, ?, ?, 'ghn', ?, ?, 'shop', 'user_test', ?)`,
        [id, uid("order"), uid("XS"), cod, fee, reported],
      );
      return id;
    };

    it("mọi cột tiền của module dự án là bigint (DB-MODEL-002)", async () => {
      await expectAll("bigint");
    });

    it("service DML (MedusaService) trả number cho bigint — kể cả > trần int4; null giữ null", async () => {
      const id = await insertQuote(ABOVE_INT4);
      const quotes = await checkout().listCheckoutQuotes({ id });
      expect(quotes.map((q) => q.total)).toEqual([ABOVE_INT4]);
      expect(typeof quotes[0]?.total).toBe("number");

      const sid = await insertShipment(ABOVE_INT4 + 1, 0, null);
      const shipment = await shipping().retrieveShipment(sid);
      expect(shipment).toMatchObject({
        cod_amount: ABOVE_INT4 + 1,
        shipping_fee: 0,
        cod_reported_amount: null,
      });
      expect(typeof shipment.cod_amount).toBe("number");
    });

    it("knex thô: int8 biên an toàn → number; NULL giữ null; numeric (sum) giữ chuỗi như trước", async () => {
      const { rows } = await db().raw(
        `SELECT 9007199254740991::bigint AS max, (-9007199254740991)::bigint AS min, 0::bigint AS zero,
                NULL::bigint AS nil,
                sum(x) AS total FROM (VALUES (1::bigint), (2::bigint)) v(x)`,
      );
      expect(rows).toEqual([
        {
          max: Number.MAX_SAFE_INTEGER,
          min: -Number.MAX_SAFE_INTEGER,
          zero: 0,
          nil: null,
          total: "3",
        },
      ]);
    });

    it("int8 vượt 2^53 − 1 → truy vấn bị từ chối (RangeError), không làm tròn lặng lẽ; kết nối vẫn dùng được", async () => {
      await expect(db().raw(`SELECT 9007199254740992::bigint AS v`)).rejects.toThrow(RangeError);
      const { rows } = await db().raw(`SELECT 1::bigint AS v`);
      expect(rows).toEqual([{ v: 1 }]);
    });

    it("đồng thời: 20 lần đọc song song (DML + knex) đều nhận number đúng giá trị", async () => {
      const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => insertQuote(ABOVE_INT4 + i)));
      const reads = await Promise.all([
        ...ids.map((id) => checkout().listCheckoutQuotes({ id })),
        ...ids.map((id) =>
          db()
            .raw(`SELECT total FROM checkout_quote WHERE id = ?`, [id])
            .then((r) => r.rows),
        ),
      ]);
      const totals = reads.map((r) => (r as Array<{ total: unknown }>)[0]?.total);
      expect(totals).toEqual([...ids.map((_, i) => ABOVE_INT4 + i), ...ids.map((_, i) => ABOVE_INT4 + i)]);
    });

    it("down() dừng khi có giá trị ngoài miền int4 (không cắt dữ liệu); hết giá trị lớn thì lùi về integer rồi up lại", async () => {
      const big = await insertQuote(ABOVE_INT4);
      await expect(runMigration(CheckoutT186, "down")).rejects.toThrow(/T-186 down\(\)/);
      const sid = await insertShipment(ABOVE_INT4, null, null);
      await expect(runMigration(ShippingT186, "down")).rejects.toThrow(/T-186 down\(\)/);
      await expectAll("bigint");

      await db().raw(`DELETE FROM checkout_quote WHERE total > 2147483647`);
      await db().raw(`DELETE FROM shipment WHERE id = ?`, [sid]);
      expect((await db().raw(`SELECT 1 FROM checkout_quote WHERE id = ?`, [big])).rows).toEqual([]);
      for (const M of [CheckoutT186, ShippingT186, ReturnsT186, SettlementT186])
        await runMigration(M, "down");
      await expectAll("integer");
      for (const M of [CheckoutT186, ShippingT186, ReturnsT186, SettlementT186]) await runMigration(M, "up");
      await expectAll("bigint");
    });

    it("trigger x_refund_order_lock_upd được tạo lại nguyên văn (WHEN dùng cột amount) — so chuỗi cố định", async () => {
      const def = async () =>
        (
          await db().raw(
            `SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t
              WHERE t.tgname = 'x_refund_order_lock_upd' AND t.tgrelid = 'x_refund'::regclass`,
          )
        ).rows.map((r) => String(r.d));
      // Định nghĩa gốc của Migration20261026010000 (pg_get_triggerdef, Postgres 16). Hằng cố định, không lấy từ DB: DB
      // của test đã chạy up() của T-186, so với chính nó là tautology (vd xoá điều kiện order_id vẫn xanh).
      expect(await def()).toEqual([X_REFUND_ORDER_LOCK_UPD]);
      await runMigration(ReturnsT186, "down");
      expect(await def()).toEqual([X_REFUND_ORDER_LOCK_UPD]);
      await runMigration(ReturnsT186, "up");
      expect(await def()).toEqual([X_REFUND_ORDER_LOCK_UPD]);
    });
  },
});
