import { randomUUID } from "node:crypto";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { Migration20261024173210 } from "../../src/modules/checkout/migrations/Migration20261024173210";
import { Migration20261026174000 } from "../../src/modules/checkout/migrations/Migration20261026174000";

jest.setTimeout(180 * 1000);

/** Mã lỗi Postgres: 23505 unique_violation, 23514 check_violation, 23502 not_null_violation. */
const UNIQUE = "23505";
const CHECK = "23514";

const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`;

/** Phần tối thiểu của kết nối knex do test runner cấp. */
interface RawDb {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return String((e as { code?: string }).code);
  }
  throw new Error("mong đợi DB từ chối nhưng câu lệnh thành công");
}

medusaIntegrationTestRunner({
  testSuite: ({ dbConnection, getContainer }) => {
    const db = () => dbConnection as unknown as RawDb;
    const service = () => getContainer().resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    const insertAttempt = (o: Partial<Record<string, unknown>> = {}) =>
      db().raw(
        `INSERT INTO checkout_attempt (id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash,
           quote_id, state, payment_method, lease_until)
         VALUES (?, ?, ?, ?, ?, 'h', 'cqt_1', ?, 'cod', now())`,
        [
          o.id ?? uid("chk"),
          o.cart_id ?? "cart_A",
          o.cart_version ?? 1,
          o.scope ?? "checkout.submit:cart:cart_A",
          o.key ?? uid("key"),
          o.state ?? "preparing",
        ],
      );
    const insertLedger = (o: Partial<Record<string, unknown>> = {}) =>
      db().raw(
        `INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state)
         VALUES (?, 'order_1', ?, ?, 'vnpay', ?, 'succeeded')`,
        [uid("pled"), o.kind ?? "capture", o.amount ?? 100_000, o.txn ?? "14000001"],
      );
    const insertPaymentAttempt = (o: Partial<Record<string, unknown>> = {}) =>
      db().raw(
        `INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at)
         VALUES (?, ?, 'vnpay', ?, ?, ?, now())`,
        [
          uid("payatt"),
          o.order_id ?? "order_1",
          o.txn_ref ?? uid("PA"),
          o.amount ?? 100_000,
          o.state ?? "pending",
        ],
      );
    const insertFinance = (o: Partial<Record<string, unknown>> = {}) =>
      db().raw(
        `INSERT INTO order_finance (id, order_id, display_ref, checkout_attempt_id, cart_id, state, total,
           payment_method, policy_version, quote, address, contact)
         VALUES (?, ?, ?, 'chk_1', 'cart_A', 'preparing', ?, 'cod', 'v1', '{}', '{}', '{}')`,
        [uid("ofin"), o.order_id ?? uid("order"), o.display_ref ?? uid("XS"), o.total ?? 100_000],
      );

    describe("checkout_attempt", () => {
      it("trùng (idempotency_scope, idempotency_key) → DB từ chối", async () => {
        await insertAttempt({ key: "K-1234567890abcdef", cart_version: 1 });
        expect(await pgError(insertAttempt({ key: "K-1234567890abcdef", cart_version: 2 }))).toBe(UNIQUE);
        // Cùng key ở phạm vi khác (giỏ khác) là hợp lệ.
        await insertAttempt({
          key: "K-1234567890abcdef",
          scope: "checkout.submit:cart:cart_B",
          cart_id: "cart_B",
        });
      });

      it("hai attempt hoạt động cho cùng (cart_id, cart_version) → DB từ chối; attempt failed không giữ chỗ", async () => {
        await insertAttempt({ cart_id: "cart_V", cart_version: 3, state: "failed" });
        await insertAttempt({ cart_id: "cart_V", cart_version: 3, state: "preparing" });
        expect(await pgError(insertAttempt({ cart_id: "cart_V", cart_version: 3, state: "ready" }))).toBe(
          UNIQUE,
        );
        expect(await pgError(insertAttempt({ cart_id: "cart_V", cart_version: 3, state: "preparing" }))).toBe(
          UNIQUE,
        );
        await insertAttempt({ cart_id: "cart_V", cart_version: 4, state: "preparing" });
      });

      it("trạng thái ngoài danh sách / cart_version < 1 → DB từ chối", async () => {
        expect(await pgError(insertAttempt({ state: "done" }))).toBe(CHECK);
        expect(await pgError(insertAttempt({ cart_version: 0 }))).toBe(CHECK);
      });
    });

    describe("payment_ledger", () => {
      it("trùng (provider, provider_txn_id, kind) → DB từ chối; cùng giao dịch khác kind được phép", async () => {
        await insertLedger({ txn: "14000077" });
        expect(await pgError(insertLedger({ txn: "14000077" }))).toBe(UNIQUE);
        await insertLedger({ txn: "14000077", kind: "refund", amount: 50_000 });
      });

      it.each([0, -1, -100_000])("amount = %d → DB từ chối (amount > 0)", async (amount) => {
        expect(await pgError(insertLedger({ amount, txn: uid("t") }))).toBe(CHECK);
      });

      it("amount không phải số nguyên (chuỗi '1.5') → DB từ chối", async () => {
        await expect(insertLedger({ amount: "1.5", txn: uid("t") })).rejects.toThrow(/integer/);
      });
    });

    describe("payment_attempt", () => {
      it("hai attempt hoạt động cho một đơn → DB từ chối; attempt đã failed không tính", async () => {
        await insertPaymentAttempt({ order_id: "order_P", state: "failed" });
        await insertPaymentAttempt({ order_id: "order_P", state: "pending" });
        expect(await pgError(insertPaymentAttempt({ order_id: "order_P", state: "created" }))).toBe(UNIQUE);
        expect(await pgError(insertPaymentAttempt({ order_id: "order_P", state: "unknown" }))).toBe(UNIQUE);
        // captured là kết thúc: vẫn cho phép (đơn đã trả) — không chiếm chỗ "hoạt động".
        await insertPaymentAttempt({ order_id: "order_P", state: "captured" });
      });

      it("trùng txn_ref → DB từ chối; amount ≤ 0 → DB từ chối", async () => {
        await insertPaymentAttempt({ order_id: "order_Q", txn_ref: "PA_DUP", state: "failed" });
        expect(await pgError(insertPaymentAttempt({ order_id: "order_R", txn_ref: "PA_DUP" }))).toBe(UNIQUE);
        expect(await pgError(insertPaymentAttempt({ order_id: "order_S", amount: 0 }))).toBe(CHECK);
      });
    });

    describe("order_finance, inbox, outbox, coupon, ngoại lệ, quote, cart_version", () => {
      it("order_finance: total < 0, trùng order_id, trùng display_ref → DB từ chối", async () => {
        expect(await pgError(insertFinance({ total: -1 }))).toBe(CHECK);
        await insertFinance({ order_id: "order_F", display_ref: "XS-AAAAAA" });
        expect(await pgError(insertFinance({ order_id: "order_F" }))).toBe(UNIQUE);
        expect(await pgError(insertFinance({ display_ref: "XS-AAAAAA" }))).toBe(UNIQUE);
        await insertFinance({ total: 0 });
      });

      it("webhook_inbox (provider, event_key) và outbox event_key là duy nhất", async () => {
        const inbox = () =>
          db().raw(
            `INSERT INTO webhook_inbox (id, provider, event_key, payload, payload_hash) VALUES (?, 'vnpay', 'E1', '{}', 'h')`,
            [uid("whin")],
          );
        await inbox();
        expect(await pgError(inbox())).toBe(UNIQUE);
        const outbox = () =>
          db().raw(
            `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, next_attempt_at)
             VALUES (?, 'order.placed_pending:o1', 'o1', 'order.placed_pending', '{}', now())`,
            [uid("obx")],
          );
        await outbox();
        expect(await pgError(outbox())).toBe(UNIQUE);
      });

      it("coupon_usage: trùng (code, attempt) và (code, order) → DB từ chối", async () => {
        const usage = (attempt: string, order: string | null) =>
          db().raw(
            `INSERT INTO coupon_usage (id, promotion_code, checkout_attempt_id, order_id, state)
             VALUES (?, 'GIAM10', ?, ?, 'held')`,
            [uid("cpu"), attempt, order],
          );
        await usage("chk_1", "order_1");
        expect(await pgError(usage("chk_1", null))).toBe(UNIQUE);
        expect(await pgError(usage("chk_2", "order_1"))).toBe(UNIQUE);
        await usage("chk_3", null);
        await usage("chk_4", null);
      });

      it("ops_exception amount âm, quote total âm, cart_version version 0 → DB từ chối", async () => {
        expect(
          await pgError(
            db().raw(`INSERT INTO ops_exception (id, kind, amount) VALUES (?, 'late_payment', -5)`, [
              uid("opx"),
            ]),
          ),
        ).toBe(CHECK);
        expect(
          await pgError(
            db().raw(
              `INSERT INTO checkout_quote (id, cart_id, cart_version, payment_method, address, breakdown, total, expires_at)
               VALUES (?, 'cart_A', 1, 'cod', '{}', '{}', -1, now())`,
              [uid("cqt")],
            ),
          ),
        ).toBe(CHECK);
        expect(
          await pgError(
            db().raw(
              `INSERT INTO cart_version (id, cart_id, version, fingerprint) VALUES (?, 'cart_Z', 0, 'f')`,
              [uid("cver")],
            ),
          ),
        ).toBe(CHECK);
      });
    });

    describe("service: thao tác nguyên tử", () => {
      it("observeCartVersion: lần đầu 1; cùng nội dung giữ nguyên; nội dung đổi tăng 1 và bỏ đóng băng", async () => {
        const s = service();
        const cart = uid("cart");
        expect(await s.observeCartVersion(cart, "f1")).toEqual({ version: 1, frozen_by_attempt: null });
        expect((await s.observeCartVersion(cart, "f1")).version).toBe(1);
        await db().raw(`UPDATE cart_version SET frozen_by_attempt = 'chk_x' WHERE cart_id = ?`, [cart]);
        expect(await s.observeCartVersion(cart, "f1")).toEqual({ version: 1, frozen_by_attempt: "chk_x" });
        expect(await s.observeCartVersion(cart, "f2")).toEqual({ version: 2, frozen_by_attempt: null });
        // 10 quan sát đồng thời cùng nội dung mới → đúng một lần tăng.
        const results = await Promise.all(Array.from({ length: 10 }, () => s.observeCartVersion(cart, "f3")));
        expect(new Set(results.map((r) => r.version))).toEqual(new Set([3]));
      });

      it("insertAttemptIfAbsent: 10 lần đồng thời cùng key → đúng một attempt", async () => {
        const s = service();
        const cart = uid("cart");
        const input = {
          cart_id: cart,
          cart_version: 1,
          idempotency_scope: `checkout.submit:cart:${cart}`,
          idempotency_key: "K-concurrent-0000000001",
          payload_hash: "h",
          quote_id: "cqt_1",
          payment_method: "cod" as const,
          lease_until: new Date(Date.now() + 60_000),
        };
        const ids = await Promise.all(Array.from({ length: 10 }, () => s.insertAttemptIfAbsent(input)));
        expect(ids.filter((id) => id !== null)).toHaveLength(1);
        // Khác key, cùng phiên bản giỏ đang hoạt động → cũng không tạo được (DATA02).
        expect(
          await s.insertAttemptIfAbsent({ ...input, idempotency_key: "K-other-key-000000001" }),
        ).toBeNull();
        const id = ids.find((x) => x !== null) as string;
        expect(await s.findActiveAttemptId(cart, 1)).toBe(id);
        // Chỉ một lần chuyển preparing → failed thắng; sau khi failed, phiên bản giỏ được nhả.
        const fails = await Promise.all([
          s.failAttempt(id, "PRICE_CHANGED", null),
          s.failAttempt(id, "X", null),
        ]);
        expect(fails.filter(Boolean)).toHaveLength(1);
        expect(await s.findActiveAttemptId(cart, 1)).toBeNull();
        expect(
          await s.insertAttemptIfAbsent({ ...input, idempotency_key: "K-other-key-000000001" }),
        ).not.toBeNull();
      });

      it("coupon: giữ idempotent theo attempt, đếm held+used, nhả đúng một lần", async () => {
        const s = service();
        const code = uid("CODE");
        await s.holdCoupon({ promotion_code: code, promotion_id: null, attempt_id: "chk_a" });
        await s.holdCoupon({ promotion_code: code, promotion_id: null, attempt_id: "chk_a" });
        await s.holdCoupon({ promotion_code: code, promotion_id: null, attempt_id: "chk_b" });
        expect(await s.countCountedCouponUsage(code)).toBe(2);
        expect(await s.releaseCouponHold("chk_a")).toBe(1);
        expect(await s.releaseCouponHold("chk_a")).toBe(0);
        expect(await s.countCountedCouponUsage(code)).toBe(1);
      });
    });

    // Đặt TRƯỚC "migration có đường lùi": test đó dựng lại bảng bằng migration đầu (không có index của T-074).
    describe("index trang đơn (T-074, Migration20261026174000)", () => {
      const indexes = [
        { name: "IDX_outbox_event_aggregate_id", table: "outbox_event", column: "aggregate_id" },
        { name: "IDX_payment_attempt_order_id", table: "payment_attempt", column: "order_id" },
        { name: "IDX_ops_exception_order_id", table: "ops_exception", column: "order_id" },
      ];
      const present = async () =>
        (
          await db().raw(
            `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(?) ORDER BY indexname`,
            [indexes.map((i) => i.name)],
          )
        ).rows.map((r) => ({ name: String(r.indexname), def: String(r.indexdef) }));
      const run = async (direction: "up" | "down") => {
        const m = new Migration20261026174000({} as never, {} as never);
        await m[direction]();
        for (const q of m.getQueries()) await db().raw(String(q));
      };

      it("migration đã áp tạo đủ 3 index thường (không partial) trên đúng cột", async () => {
        const rows = await present();
        expect(rows.map((r) => r.name)).toEqual(indexes.map((i) => i.name).sort());
        for (const i of indexes) {
          const def = rows.find((r) => r.name === i.name)?.def ?? "";
          expect(def).toContain(`ON public.${i.table} USING btree (${i.column})`);
          expect(def).not.toMatch(/WHERE/i);
        }
      });

      it("5.000 dòng + ANALYZE: planner chọn index mới cho đúng hình truy vấn của trang đơn (không Seq Scan)", async () => {
        // Sinh dữ liệu, ANALYZE và EXPLAIN trong MỘT giao dịch rồi ROLLBACK — thống kê và dòng không lọt sang test khác.
        const fill: Record<string, string> = {
          outbox_event: `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, next_attempt_at)
            SELECT 'obx_t' || g, 'k:' || g, 'order_t' || (g / 3), 'order.placed', '{}'::jsonb, 'sent', now()
              FROM generate_series(1, 5000) g`,
          payment_attempt: `INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at)
            SELECT 'payatt_t' || g, 'order_t' || (g / 2), 'vnpay', 'T' || g, 1000, 'captured', now()
              FROM generate_series(1, 5000) g`,
          ops_exception: `INSERT INTO ops_exception (id, kind, order_id, state)
            SELECT 'opx_t' || g, 'payment_unknown', 'order_t' || g, 'resolved' FROM generate_series(1, 5000) g`,
        };
        const knex = dbConnection as unknown as {
          transaction(fn: (trx: RawDb) => Promise<void>): Promise<void>;
        };
        const ROLLBACK = new Error("rollback có chủ đích");
        for (const i of indexes) {
          let plan = "";
          await knex
            .transaction(async (trx) => {
              const sql = fill[i.table];
              if (!sql) throw new Error(`thiếu câu sinh dữ liệu cho ${i.table}`);
              await trx.raw(sql);
              await trx.raw(`ANALYZE ${i.table}`);
              const r = await trx.raw(
                `EXPLAIN SELECT * FROM ${i.table} WHERE ${i.column} = ? AND deleted_at IS NULL`,
                ["order_t42"],
              );
              plan = r.rows.map((x) => String(x["QUERY PLAN"])).join("\n");
              throw ROLLBACK;
            })
            .catch((e: unknown) => {
              if (e !== ROLLBACK) throw e;
            });
          expect(plan).toMatch(new RegExp(`Index Scan (using|on) "${i.name}"`)); // Index Scan hoặc Bitmap Index Scan
          expect(plan).not.toContain("Seq Scan");
        }
        expect(
          Number(
            (await db().raw(`SELECT count(*) AS n FROM outbox_event WHERE id LIKE 'obx_t%'`)).rows[0]?.n,
          ),
        ).toBe(0);
      });

      it("down() xoá đúng 3 index (không đụng index khác), up() tạo lại, up() lần hai không lỗi", async () => {
        const others = async () =>
          (
            await db().raw(
              `SELECT count(*)::int AS n FROM pg_indexes
                WHERE tablename IN ('outbox_event', 'payment_attempt', 'ops_exception') AND NOT (indexname = ANY(?))`,
              [indexes.map((i) => i.name)],
            )
          ).rows[0]?.n;
        const before = await others();
        await run("down");
        expect(await present()).toEqual([]);
        expect(await others()).toBe(before);
        await run("up");
        await run("up");
        expect((await present()).map((r) => r.name)).toEqual(indexes.map((i) => i.name).sort());
      });
    });

    describe("migration có đường lùi", () => {
      it("down() xoá sạch bảng của module, up() tạo lại đủ ràng buộc", async () => {
        const tables = [
          "cart_version",
          "checkout_attempt",
          "checkout_quote",
          "coupon_usage",
          "ops_exception",
          "order_finance",
          "outbox_event",
          "payment_attempt",
          "payment_ledger",
          "webhook_inbox",
        ];
        const existing = async () =>
          (
            await db().raw(`SELECT table_name FROM information_schema.tables WHERE table_name = ANY(?)`, [
              tables,
            ])
          ).rows.map((r) => String(r.table_name));
        expect((await existing()).sort()).toEqual(tables);

        const run = async (direction: "up" | "down") => {
          // Migration của MikroORM chỉ gom câu SQL (addSql) — chạy chúng trên kết nối test.
          const m = new Migration20261024173210({} as never, {} as never);
          await m[direction]();
          for (const q of m.getQueries()) await db().raw(String(q));
        };
        await run("down");
        expect(await existing()).toEqual([]);
        await run("up");
        expect((await existing()).sort()).toEqual(tables);
        await insertLedger({ txn: "14009999" });
        expect(await pgError(insertLedger({ txn: "14009999" }))).toBe(UNIQUE);
      });
    });
  },
});
