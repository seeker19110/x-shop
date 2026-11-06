import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { RETURNS_MODULE } from "../../src/modules/returns";
import {
  ORDER_LOCK_KEY_PREFIX,
  REFUND_LOCK_REQUIRED_SQLSTATE,
  orderLockKey,
} from "../../src/modules/returns/constants";
import { Migration20261026010000 } from "../../src/modules/returns/migrations/Migration20261026010000";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

const XR = REFUND_LOCK_REQUIRED_SQLSTATE;
const FN = "x_refund_require_order_lock";
const TRIGGERS = ["x_refund_order_lock_ins", "x_refund_order_lock_upd"];

/**
 * T-052 (D-032) — hàng rào DB cho bất biến hoàn tiền: trigger trên `x_refund` từ chối (SQLSTATE XR001) mọi ghi làm tăng
 * tiền chiếm chỗ của đơn khi phiên hiện tại không giữ khóa advisory `x-returns:order:<order_id>` (`lockOrder`). Đường
 * ghi thật (tạo hoàn từ Admin, hủy đơn đã thu, hãng hoàn hàng, kiểm định hàng trả) vẫn chạy; down migration gỡ sạch.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"order_staff" | "support" | "warehouse" | "accountant", MfaAdmin>;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const A = (role: keyof typeof staff) => staff[role].headers;
    const pg = (): Knex => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);

    let seq = 0;
    /** Một dòng `x_refund` hợp lệ theo mọi CHECK/UNIQUE — chỉ thiếu khóa đơn (nếu không lấy). */
    const rawRow = (orderId: string, extra: Record<string, unknown> = {}) => {
      const n = `${Date.now()}${++seq}`;
      return {
        id: `xrfd_t052_${n}`,
        order_id: orderId,
        reason: "other",
        amount: 1_000,
        method: "manual",
        provider: "manual",
        state: "requested",
        approval_required: false,
        requested_by: "test",
        provider_request_id: `RFT052${n}`,
        idempotency_key: `t052:${n}`,
        payload_hash: "t052",
        ...extra,
      };
    };
    /** SQLSTATE của lỗi (hoặc "ok"). */
    const outcome = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => "ok",
        (e: unknown) => (e as { code?: string }).code ?? `no-code: ${String(e)}`,
      );
    const insertUnlocked = (row: object) =>
      outcome(
        pg()("x_refund")
          .insert(row)
          .then(() => undefined),
      );
    const insertWithLock = (lockOrderId: string, row: object) =>
      outcome(
        pg().transaction(async (trx) => {
          await returns().lockOrder(trx, lockOrderId);
          await trx("x_refund").insert(row);
        }),
      );
    const seedRow = async <T extends { id: string; order_id: string }>(row: T): Promise<T> => {
      expect(await insertWithLock(row.order_id, row)).toBe("ok");
      return row;
    };
    const updateUnlocked = (id: string, patch: object) =>
      outcome(
        pg()("x_refund")
          .where({ id })
          .update(patch)
          .then(() => undefined),
      );
    const updateWithLock = (lockOrderId: string, id: string, patch: object) =>
      outcome(
        pg().transaction(async (trx) => {
          await returns().lockOrder(trx, lockOrderId);
          await trx("x_refund").where({ id }).update(patch);
        }),
      );
    const rowOf = async (id: string) =>
      (await pg()("x_refund").where({ id }).first()) as { state: string; amount: number; order_id: string };
    const refundsOf = async (orderId: string) =>
      (await pg()("x_refund").where({ order_id: orderId }).select("reason", "amount", "state")) as Array<{
        reason: string;
        amount: number;
        state: string;
      }>;
    const guardObjects = async () => {
      const triggers = (
        await pg().raw(
          `select tgname from pg_trigger where tgrelid = 'x_refund'::regclass and not tgisinternal order by tgname`,
        )
      ).rows.map((r: { tgname: string }) => r.tgname);
      const fns = (await pg().raw(`select proname from pg_proc where proname = '${FN}'`)).rows.length;
      return { triggers, fns };
    };
    const runMigration = async (direction: "up" | "down") => {
      // Migration của MikroORM chỉ gom câu SQL (addSql) — chạy chúng trên kết nối test.
      const m = new Migration20261026010000({} as never, {} as never);
      await m[direction]();
      for (const q of m.getQueries()) await pg().raw(String(q));
    };

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "accountant"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
      setRefundGatewayForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container);
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
      ip = newIp();
    });

    describe("chèn x_refund", () => {
      it("không khóa (autocommit) → XR001, không ghi gì; thông điệp nêu đơn và cách sửa", async () => {
        const row = rawRow("order_t052_nolock");
        const err = await pg()("x_refund")
          .insert(row)
          .then(
            () => null,
            (e: { code?: string; message?: string; hint?: string }) => e,
          );
        expect(err?.code).toBe(XR);
        expect(err?.message).toContain("order_t052_nolock");
        expect(err?.message).toContain("cần khóa advisory theo đơn");
        expect(err?.hint).toContain("lockOrder");
        expect(await rowOf(row.id)).toBeUndefined();
        // Qua service, trong transaction nhưng quên lockOrder → cũng bị chặn.
        const viaService = await outcome(
          pg().transaction((trx) => returns().insertRefund(trx, rawRow("order_t052_svc") as never)),
        );
        expect(viaService).toBe(XR);
      });

      it("transaction giữ khóa của đơn KHÁC → XR001; giữ đúng khóa → ghi được", async () => {
        const row = rawRow("order_t052_a");
        expect(await insertWithLock("order_t052_b", row)).toBe(XR);
        expect(await rowOf(row.id)).toBeUndefined();
        expect(await insertWithLock("order_t052_a", row)).toBe("ok");
        expect(await rowOf(row.id)).toMatchObject({ order_id: "order_t052_a", state: "requested" });
      });

      it("khớp khóa đúng cả khi hashtext âm lẫn dương (classid/objid từ bigint mở rộng dấu)", async () => {
        const ids = Array.from({ length: 24 }, (_, i) => `order_t052_h${i}`);
        const signs = (
          await pg().raw(`select s, hashtext(s) < 0 as neg from unnest(?::text[]) s`, [ids.map(orderLockKey)])
        ).rows as Array<{ s: string; neg: boolean }>;
        const neg = signs.find((r) => r.neg);
        const pos = signs.find((r) => !r.neg);
        expect(neg && pos).toBeTruthy();
        for (const r of [neg!, pos!]) {
          const orderId = r.s.slice(ORDER_LOCK_KEY_PREFIX.length);
          expect(await insertUnlocked(rawRow(orderId))).toBe(XR);
          expect(await insertWithLock(orderId, rawRow(orderId))).toBe("ok");
        }
      });

      it("khóa dạng khác cùng số không được tính: _shared (ShareLock), hai khóa int4 (objsubid 2)", async () => {
        const orderId = "order_t052_forms";
        const h = Number(
          (await pg().raw(`select hashtext(?) as h`, [orderLockKey(orderId)])).rows[0].h as number | string,
        );
        const shared = await outcome(
          pg().transaction(async (trx) => {
            await trx.raw(`select pg_advisory_xact_lock_shared(hashtext(?))`, [orderLockKey(orderId)]);
            await trx("x_refund").insert(rawRow(orderId));
          }),
        );
        expect(shared).toBe(XR);
        // pg_advisory_xact_lock(int4, int4): classid = khóa 1, objid = khóa 2 — trùng số với dạng bigint khi hashtext ≥ 0
        // (classid 0) hoặc < 0 (classid 4294967295 không biểu diễn được bằng int4 → dùng -1).
        const twoKey = await outcome(
          pg().transaction(async (trx) => {
            await trx.raw(`select pg_advisory_xact_lock(?::int, ?::int)`, [h < 0 ? -1 : 0, h]);
            await trx("x_refund").insert(rawRow(orderId));
          }),
        );
        expect(twoKey).toBe(XR);
      });

      it("đồng thời: phiên KHÁC đang giữ khóa của đơn → phiên không khóa vẫn bị chặn ngay (không chờ, không mượn khóa)", async () => {
        const orderId = "order_t052_peer";
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const holder = pg().transaction(async (trx) => {
          await returns().lockOrder(trx, orderId);
          locked();
          await held;
        });
        await isLocked;
        try {
          const t0 = Date.now();
          expect(await insertUnlocked(rawRow(orderId))).toBe(XR);
          expect(Date.now() - t0).toBeLessThan(5_000);
        } finally {
          release();
          await holder;
        }
        expect(await refundsOf(orderId)).toEqual([]);
      });
    });

    describe("cập nhật x_refund", () => {
      it("không khóa: rejected/cancelled → còn hiệu lực, tăng amount, đổi order_id → XR001; có khóa → được", async () => {
        const orderId = "order_t052_upd";
        const cancelled = await seedRow(rawRow(orderId, { state: "cancelled" }));
        const rejected = await seedRow(rawRow(orderId, { state: "rejected" }));
        const live = await seedRow(rawRow(orderId, { state: "approved", amount: 5_000 }));

        expect(await updateUnlocked(cancelled.id, { state: "requested" })).toBe(XR);
        expect(await updateUnlocked(rejected.id, { state: "approved" })).toBe(XR);
        expect(await updateUnlocked(live.id, { amount: 5_001 })).toBe(XR);
        expect(await updateUnlocked(live.id, { order_id: "order_t052_other" })).toBe(XR);
        expect(await rowOf(cancelled.id)).toMatchObject({ state: "cancelled" });
        expect(await rowOf(live.id)).toMatchObject({ amount: 5_000, order_id: orderId });

        // Khóa của đơn khác không đủ; đổi order_id cần khóa của đơn MỚI.
        expect(await updateWithLock("order_t052_x", cancelled.id, { state: "requested" })).toBe(XR);
        expect(await updateWithLock(orderId, live.id, { order_id: "order_t052_other" })).toBe(XR);
        expect(await updateWithLock(orderId, cancelled.id, { state: "requested" })).toBe("ok");
        expect(await updateWithLock(orderId, live.id, { amount: 6_000 })).toBe("ok");
        expect(await rowOf(cancelled.id)).toMatchObject({ state: "requested" });
        expect(await rowOf(live.id)).toMatchObject({ amount: 6_000 });
      });

      it("không làm tăng tổng → không cần khóa: chuyển trạng thái của workflow, giảm amount, nhả về rejected/cancelled", async () => {
        const orderId = "order_t052_flow";
        const r = await seedRow(rawRow(orderId, { state: "requested", amount: 9_000 }));
        for (const state of ["approved", "processing", "unknown", "failed", "processing", "succeeded"]) {
          expect(await updateUnlocked(r.id, { state })).toBe("ok");
        }
        const f = await seedRow(rawRow(orderId, { state: "failed" }));
        expect(await updateUnlocked(f.id, { state: "cancelled", amount: 999 })).toBe("ok");
        const q = await seedRow(rawRow(orderId, { state: "requested", amount: 2_000 }));
        expect(await updateUnlocked(q.id, { amount: 1_500, note: "giảm" })).toBe("ok");
        expect(await updateUnlocked(q.id, { state: "rejected" })).toBe("ok");
        // Đã nhả rồi đổi amount mà vẫn ở trạng thái nhả → không chiếm tiền, không kiểm.
        expect(await updateUnlocked(q.id, { amount: 50_000 })).toBe("ok");
      });
    });

    describe("đường ghi thật vẫn xanh (đều lấy lockOrder trước khi ghi)", () => {
      const lineOf = async (orderId: string, variantKey: string) => {
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "order",
          fields: ["id", "items.id", "items.variant_id"],
          filters: { id: orderId },
        });
        const items = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items;
        return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
      };

      it("Admin tạo hoàn (createRefund) → 201; hai yêu cầu song song vượt tổng → một 201, một 422", async () => {
        const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
        const create = (amount: number) =>
          flow.admin(
            "/admin/x/refunds",
            A("accountant"),
            { order_id: o.orderId, reason: "other", amount, note: "Hoàn bù chênh lệch" },
            { "Idempotency-Key": key() },
          );
        const one = await create(100_000);
        expect(one.status).toBe(201);
        const half = Math.floor((o.total - 100_000) / 2) + 1;
        const both = await Promise.all([create(half), create(half)]);
        expect(both.map((r) => (r.status === 201 ? "201" : `${r.status}:${r.data.code}`)).sort()).toEqual([
          "201",
          "422:REFUND_EXCEEDS_CAPTURED",
        ]);
        const rows = await refundsOf(o.orderId);
        expect(rows).toHaveLength(2);
        expect(rows.reduce((s, r) => s + Number(r.amount), 0)).toBeLessThanOrEqual(o.total);
      });

      it("khách hủy đơn đã thu → mở hoàn hủy đơn", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const c = await flow.cancel(o);
        expect(c.status).toBe(200);
        expect(c.data.cancel).toEqual({ outcome: "cancelled", refund_requested: true });
        expect(await refundsOf(o.orderId)).toEqual([
          { reason: "cancellation", amount: o.total, state: "requested" },
        ]);
      });

      it("hãng hoàn hàng về người gửi (returned) → mở hoàn hủy đơn", async () => {
        const o: PlacedOrder = await flow.place([["Trắng/S", 1]], "vnpay");
        const created = (await api.post(
          `/admin/x/orders/${o.orderId}/shipments`,
          {},
          { headers: A("order_staff"), validateStatus: () => true },
        )) as Res<J>;
        expect(created.status).toBe(201);
        const code = created.data.shipment.provider_order_code as string;
        let tick = 0;
        for (const st of [
          "delivering",
          "delivery_fail",
          "waiting_to_return",
          "return",
          "return_transporting",
          "returned",
        ]) {
          ghn.setStatusByOrderCode(code, st);
          const r = (await api.post(
            "/x/webhooks/shipping/ghn",
            {
              OrderCode: code,
              Type: "Switch_status",
              Status: st,
              Time: new Date(Date.UTC(2026, 9, 26, 3, 0, 0) + ++tick * 60_000).toISOString(),
              CODAmount: 0,
            },
            { validateStatus: () => true },
          )) as Res<J>;
          expect(r.status).toBe(200);
        }
        expect(await refundsOf(o.orderId)).toEqual([
          { reason: "cancellation", amount: o.total, state: "requested" },
        ]);
      });

      it("kiểm định hàng trả đạt → mở hoàn theo kiểm định", async () => {
        const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
        const line = await lineOf(o.orderId, "Đen/M");
        const req = await flow.requestReturn(o, {
          kind: "return",
          reason: "changed_mind",
          lines: [{ line_id: line, quantity: 1 }],
        });
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.status).toBe(200);
        expect(inspected.data.refund).toMatchObject({ state: "requested" });
        const rows = await refundsOf(o.orderId);
        expect(rows).toEqual([
          { reason: "return", amount: inspected.data.refund.amount, state: "requested" },
        ]);
        expect(Number(rows[0]!.amount)).toBeGreaterThan(0);
      });
    });

    describe("migration", () => {
      it(`function trong DB dùng đúng tiền tố ORDER_LOCK_KEY_PREFIX ('${ORDER_LOCK_KEY_PREFIX}')`, async () => {
        const def = (await pg().raw(`select pg_get_functiondef('${FN}'::regproc) as d`)).rows[0].d as string;
        expect(def).toContain(`'${ORDER_LOCK_KEY_PREFIX}' ||`);
        expect(def).toContain(`'${XR}'`);
      });

      it("down gỡ sạch trigger + function (ghi không khóa lại được); up dựng lại", async () => {
        expect(await guardObjects()).toEqual({ triggers: TRIGGERS, fns: 1 });
        try {
          await runMigration("down");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          const row = rawRow("order_t052_down", { state: "cancelled" });
          expect(await insertUnlocked(row)).toBe("ok");
          expect(await updateUnlocked(row.id, { state: "requested" })).toBe("ok");
        } finally {
          await runMigration("up");
        }
        expect(await guardObjects()).toEqual({ triggers: TRIGGERS, fns: 1 });
        expect(await insertUnlocked(rawRow("order_t052_down"))).toBe(XR);
        // Chạy up lần nữa không lỗi (create or replace / drop if exists).
        await runMigration("up");
        expect(await guardObjects()).toEqual({ triggers: TRIGGERS, fns: 1 });
      });
    });
  },
});
