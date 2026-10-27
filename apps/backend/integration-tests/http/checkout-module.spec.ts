import { randomUUID } from "node:crypto";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ORDER_STATES } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { Migration20261024173210 } from "../../src/modules/checkout/migrations/Migration20261024173210";
import { Migration20261026174000 } from "../../src/modules/checkout/migrations/Migration20261026174000";
import { Migration20261026210000 as FashionT101 } from "../../src/modules/fashion/migrations/Migration20261026210000";
import { Migration20261026210500 as ImportT101 } from "../../src/modules/catalog-import/migrations/Migration20261026210500";

jest.setTimeout(180 * 1000);

/** Mã lỗi Postgres: 23505 unique_violation, 23514 check_violation, 23503 foreign_key_violation. */
const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";

const uid = (p: string) => `${p}_${randomUUID().replace(/-/g, "")}`;

/** Phần tối thiểu của kết nối knex do test runner cấp. */
interface RawDb {
  raw(sql: string, bindings?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function pgError(promise: Promise<unknown>): Promise<string> {
  return (await pgFailure(promise)).code;
}

async function pgFailure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: String(err.code), message: String(err.message) };
  }
  throw new Error("mong đợi DB từ chối nhưng câu lệnh thành công");
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

    // T-101 (DB-MODEL-004/005): vi phạm do scripts/ops/check-schema.mjs tìm ra, sửa bằng migration mới ở từng module.
    // Đặt TRƯỚC "migration có đường lùi" (test đó dựng lại bảng checkout bằng migration đầu — mất CHECK của T-101).
    describe("ràng buộc schema T-101 (check-schema.mjs)", () => {
      const runMigration = async (M: MigrationClass, direction: "up" | "down") => {
        const m = new M({} as never, {} as never);
        await m[direction]();
        for (const q of m.getQueries()) await db().raw(String(q));
      };
      const fkRule = async () =>
        String(
          (
            await db().raw(
              `SELECT confdeltype FROM pg_constraint WHERE conname = 'fashion_model_measurement_attributes_id_foreign'`,
            )
          ).rows[0]?.confdeltype,
        );
      const insertAttributes = (id: string) =>
        db().raw(`INSERT INTO fashion_product_attributes (id, kind) VALUES (?, 'apparel')`, [id]);
      const insertMeasurement = (o: Partial<Record<string, unknown>> = {}) =>
        db().raw(
          `INSERT INTO fashion_model_measurement (id, image_set, height_cm, chest_cm, size_worn, attributes_id)
           VALUES (?, 'set-1', ?, ?, 'M', ?)`,
          [o.id ?? uid("fmm"), o.height ?? 170, o.chest ?? null, o.attributes_id],
        );
      const insertImportJob = (total: number, valid: number, id = uid("cij")) =>
        db().raw(
          `INSERT INTO catalog_import_job (id, file_hash, content, rows_total, rows_valid, errors, summary, previewed_by)
           VALUES (?, 'h', 'c', ?, ?, '[]', '{}', 'user_1')`,
          [id, total, valid],
        );
      const insertCancel = (fromState: string | null) =>
        db().raw(
          `INSERT INTO x_order_cancel (id, order_id, idempotency_key, payload_hash, actor_id, reason, outcome, from_state)
           VALUES (?, 'order_1', ?, 'h', 'user_1', 'khách đổi ý', 'cancelled', ?)`,
          [uid("xoc"), uid("key"), fromState],
        );
      const count = async (sql: string, bindings: unknown[] = []) =>
        Number((await db().raw(sql, bindings)).rows[0]?.n);

      it("FK số đo người mẫu → thuộc tính: ON DELETE RESTRICT — xoá cha còn con bị từ chối, xoá con trước thì được", async () => {
        expect(await fkRule()).toBe("r");
        const attr = uid("fattr");
        await insertAttributes(attr);
        await insertMeasurement({ attributes_id: attr });
        expect(await pgError(db().raw(`DELETE FROM fashion_product_attributes WHERE id = ?`, [attr]))).toBe(
          FOREIGN_KEY,
        );
        await db().raw(`DELETE FROM fashion_model_measurement WHERE attributes_id = ?`, [attr]);
        await db().raw(`DELETE FROM fashion_product_attributes WHERE id = ?`, [attr]);
      });

      it("cột FK có index thường (không partial)", async () => {
        const defs = (
          await db().raw(`SELECT indexdef FROM pg_indexes WHERE indexname = ANY(?) ORDER BY indexname`, [
            [
              "IDX_fashion_model_measurement_attributes_fk",
              "IDX_x_settlement_discrepancy_batch",
              "IDX_x_settlement_discrepancy_line",
            ],
          ])
        ).rows.map((r) => String(r.indexdef));
        expect(defs).toHaveLength(3);
        expect(defs[0]).toContain("fashion_model_measurement USING btree (attributes_id)");
        expect(defs[1]).toContain("x_settlement_discrepancy USING btree (batch_id)");
        expect(defs[2]).toContain("x_settlement_discrepancy USING btree (line_id)");
        for (const def of defs) expect(def).not.toMatch(/WHERE/i);
      });

      it("số đo người mẫu ≤ 0 cm / phiên bản bảng size < 1 → DB từ chối; null và giá trị dương được", async () => {
        const attr = uid("fattr");
        await insertAttributes(attr);
        expect(await pgError(insertMeasurement({ attributes_id: attr, height: 0 }))).toBe(CHECK);
        expect(await pgError(insertMeasurement({ attributes_id: attr, chest: -1 }))).toBe(CHECK);
        await insertMeasurement({ attributes_id: attr, chest: null });
        await insertMeasurement({ attributes_id: attr, chest: 88 });
        const chart = (version: number) =>
          db().raw(
            `INSERT INTO size_chart (id, code, version, name, garment_type, columns, rows)
             VALUES (?, ?, ?, 'Áo', 'ao', '[]', '[]')`,
            [uid("szc"), uid("CODE"), version],
          );
        expect(await pgError(chart(0))).toBe(CHECK);
        await chart(1);
      });

      it("trạng thái sổ tiền khác 'succeeded' / nguồn webhook ngoài ipn|query → DB từ chối", async () => {
        expect(
          await pgError(
            db().raw(
              `INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state)
               VALUES (?, 'order_1', 'capture', 1000, 'vnpay', ?, 'pending')`,
              [uid("pled"), uid("t")],
            ),
          ),
        ).toBe(CHECK);
        const inbox = (source: string) =>
          db().raw(
            `INSERT INTO webhook_inbox (id, provider, event_key, source, payload, payload_hash)
             VALUES (?, 'vnpay', ?, ?, '{}', 'h')`,
            [uid("whin"), uid("E"), source],
          );
        expect(await pgError(inbox("webhook"))).toBe(CHECK);
        expect(await pgError(inbox(""))).toBe(CHECK);
        await inbox("ipn");
        await inbox("query");
      });

      it("số giữ âm ở sổ điều chỉnh tồn / số lần thử âm / bộ đếm dòng nhập CSV lệch → DB từ chối", async () => {
        expect(
          await pgError(
            db().raw(
              `INSERT INTO inventory_adjustment (id, idempotency_key, payload_hash, inventory_item_id, location_id, delta,
                 reason, stocked_before, stocked_after, reserved_quantity)
               VALUES (?, ?, 'h', 'iitem_1', 'sloc_1', -1, 'kiểm kê', 5, 4, -1)`,
              [uid("iadj"), uid("key")],
            ),
          ),
        ).toBe(CHECK);
        expect(
          await pgError(
            db().raw(`INSERT INTO catalog_index_dirty (product_id, attempts) VALUES (?, -1)`, [uid("prod")]),
          ),
        ).toBe(CHECK);
        expect(await pgError(insertImportJob(-1, 0))).toBe(CHECK);
        expect(await pgError(insertImportJob(3, -1))).toBe(CHECK);
        expect(await pgError(insertImportJob(3, 4))).toBe(CHECK);
        await insertImportJob(0, 0);
        await insertImportJob(3, 3);
      });

      it("trạng thái gốc của lệnh hủy ngoài ORDER_STATES → DB từ chối; mọi ORDER_STATES và null được", async () => {
        expect(await pgError(insertCancel("shipped"))).toBe(CHECK);
        await insertCancel(null);
        for (const s of ORDER_STATES) await insertCancel(s);
      });

      it("tiền thực nhận âm ở chênh lệch đối soát → DB từ chối ngay (trước FK hoãn tới commit)", async () => {
        expect(
          await pgError(
            db().raw(
              `INSERT INTO x_settlement_discrepancy (id, kind, source, reference, actual_amount, amount, batch_id, dedupe_key)
               VALUES (?, 'unexpected', 'ghn_cod', 'R1', -1, 1, 'xstb_none', ?)`,
              [uid("xstd"), uid("dk")],
            ),
          ),
        ).toBe(CHECK);
        // Migration20261026220000: actual_amount NOT NULL (mọi đường ghi đều có số; `missing` ghi 0).
        expect(
          await pgError(
            db().raw(
              `INSERT INTO x_settlement_discrepancy (id, kind, source, reference, actual_amount, amount, batch_id, dedupe_key)
               VALUES (?, 'unexpected', 'ghn_cod', 'R1', NULL, 1, 'xstb_none', ?)`,
              [uid("xstd"), uid("dk")],
            ),
          ),
        ).toBe("23502");
      });

      // DB-MODEL-005: mỗi module tùy biến ≥ 1 ca dữ liệu xấu chèn thẳng SQL (không qua ORM) bị DB từ chối. checkout,
      // fashion, catalog-import, catalog-index (dirty), audit (inventory_adjustment), returns (x_order_cancel), settlement
      // (discrepancy) có ca riêng ở trên; audit_log chỉ-ghi-thêm ở audit.spec.
      it.each([
        ["rbac", `INSERT INTO user_role (user_id, role) VALUES ('user_x', 'superadmin')`, CHECK],
        [
          "shipping",
          `INSERT INTO shipment (id, order_id, client_order_code, provider, cod_amount, payer, created_by)
           VALUES ('shp_bad', 'order_1', 'XS-BAD-1', 'ghn', -1, 'recipient', 'user_1')`,
          CHECK,
        ],
        [
          "notify",
          `INSERT INTO outbound_message (id, message_key, aggregate_id, template, channel, recipient_masked, adapter)
           VALUES ('omsg_bad', 'k-bad', 'order_1', 'order_placed', 'fax', 'a***@x', 'log')`,
          CHECK,
        ],
        [
          "returns",
          `INSERT INTO x_return (id, order_id, kind, reason, channel, idempotency_key, payload_hash)
           VALUES ('xret_bad', 'order_1', 'swap', 'other', 'customer', 'k-bad-ret', 'h')`,
          CHECK,
        ],
        [
          "returns (dòng)",
          `INSERT INTO x_return_line (id, return_id, order_line_item_id, quantity)
           VALUES ('xrl_bad', 'xret_none', 'ordli_1', 0)`,
          CHECK,
        ],
        [
          "settlement",
          `INSERT INTO x_settlement_batch (id, source, content_hash, row_count, total_amount, imported_by)
           VALUES ('xstb_bad', 'ghn_cod', 'không-phải-sha256', 1, 0, 'user_1')`,
          CHECK,
        ],
        [
          "catalog-index",
          `INSERT INTO catalog_variant_index (variant_id, sales_channel_id, product_id, handle, title, sku, search_text,
             price, in_stock, created_at)
           VALUES ('variant_bad', 'sc_1', 'prod_1', 'h', 't', 'SKU-BAD', 's', -1, true, now())`,
          CHECK,
        ],
      ])("%s: dữ liệu xấu chèn thẳng SQL → DB từ chối", async (_module, sql, code) => {
        expect(await pgError(db().raw(sql))).toBe(code);
      });

      it("fashion: trùng giá trị màu còn hiệu lực → DB từ chối (UNIQUE partial)", async () => {
        const color = () =>
          db().raw(`INSERT INTO fashion_color (id, value, label) VALUES (?, 'do-t101', 'Đỏ')`, [uid("fcol")]);
        await color();
        expect(await pgError(color())).toBe(UNIQUE);
      });

      it("migration CHECK dừng (không sửa dữ liệu) khi còn dòng vi phạm; sửa dữ liệu rồi chạy lại được, up() lặp không lỗi", async () => {
        await runMigration(ImportT101, "down");
        const bad = uid("cij");
        await insertImportJob(2, 5, bad);
        const failure = await pgFailure(runMigration(ImportT101, "up"));
        expect(failure.code).toBe(CHECK);
        expect(failure.message).toMatch(
          /T-101: 1 dòng của catalog_import_job vi phạm catalog_import_job_rows_valid_range/,
        );
        // Dòng vi phạm còn nguyên — migration không tự sửa dữ liệu.
        expect(await count(`SELECT rows_valid AS n FROM catalog_import_job WHERE id = ?`, [bad])).toBe(5);
        await db().raw(`UPDATE catalog_import_job SET rows_valid = 2 WHERE id = ?`, [bad]);
        await runMigration(ImportT101, "up");
        await runMigration(ImportT101, "up");
        expect(await pgError(insertImportJob(1, 2))).toBe(CHECK);
      });

      it("migration fashion: down() trả FK về mặc định + gỡ index/CHECK, up() khai lại; dữ liệu giữ nguyên", async () => {
        const attr = uid("fattr");
        await insertAttributes(attr);
        await insertMeasurement({ attributes_id: attr });
        const idx = () =>
          count(
            `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'IDX_fashion_model_measurement_attributes_fk'`,
          );
        await runMigration(FashionT101, "down");
        expect(await fkRule()).toBe("a");
        expect(await idx()).toBe(0);
        await insertMeasurement({ attributes_id: attr, height: 0 }); // CHECK đã gỡ
        await db().raw(`DELETE FROM fashion_model_measurement WHERE height_cm = 0 AND attributes_id = ?`, [
          attr,
        ]);
        await runMigration(FashionT101, "up");
        expect(await fkRule()).toBe("r");
        expect(await idx()).toBe(1);
        expect(
          await count(`SELECT count(*)::int AS n FROM fashion_model_measurement WHERE attributes_id = ?`, [
            attr,
          ]),
        ).toBe(1);
        expect(await pgError(insertMeasurement({ attributes_id: attr, height: 0 }))).toBe(CHECK);
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
