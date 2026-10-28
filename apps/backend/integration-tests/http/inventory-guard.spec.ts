import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { expireHolds } from "../../src/lib/checkout/jobs";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { INVENTORY_GUARD_CONSTRAINT } from "../../src/lib/inventory/guard";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import { Migration20261028150000 } from "../../src/modules/checkout/migrations/Migration20261028150000";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import {
  countOrders,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  setStock,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

const GUARD = INVENTORY_GUARD_CONSTRAINT;
/** Bốn constraint trigger (D-134): inventory_level + reservation_item, INSERT/UPDATE tách để WHEN dùng được OLD. */
const TRIGGERS = [
  { table: "inventory_level", tgname: `${GUARD}_ins` },
  { table: "inventory_level", tgname: `${GUARD}_upd` },
  { table: "reservation_item", tgname: "x_reservation_item_stock_guard_ins" },
  { table: "reservation_item", tgname: "x_reservation_item_stock_guard_upd" },
];
const CHECK_VIOLATION = "23514";
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * T-185 (Q-13, RK-001, IND-ECOM-001) — hàng rào DB cho tồn kho: constraint trigger `DEFERRABLE INITIALLY DEFERRED` trên
 * `inventory_level` (migration checkout Migration20261028150000) từ chối LÚC COMMIT mọi dòng còn sống không giữ
 * `0 <= reserved_quantity <= stocked_quantity`. Ghi trực tiếp vi phạm bị từ chối; trạng thái trung gian trong cùng
 * transaction được phép; mọi luồng ghi thật (checkout, hết hạn giữ, xuất kho, điều chỉnh, đổi trả, GHN hủy/hoàn) vẫn
 * chạy; vi phạm tới tay client là 409 hết hàng, không 500; hai checkout tranh dòng cuối → một thắng, không bán âm.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"order_staff" | "support" | "warehouse" | "owner", MfaAdmin>;
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const A = (role: keyof typeof staff) => staff[role].headers;
    const pg = (): Knex => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);

    /** SQLSTATE của lỗi (hoặc "ok"). */
    const outcome = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => "ok",
        (e: unknown) => (e as { code?: string }).code ?? `no-code: ${String(e)}`,
      );
    const levelRow = async (variantKey: string, locationId = fx.sellableLocationId) => {
      const row = await pg()("inventory_level")
        .where({ inventory_item_id: fx.variants[variantKey]!.inventoryItemId, location_id: locationId })
        .whereNull("deleted_at")
        .first<{ id: string; stocked_quantity: string; reserved_quantity: string }>();
      return {
        id: row!.id,
        stocked: Number(row!.stocked_quantity),
        reserved: Number(row!.reserved_quantity),
      };
    };
    const quarantine = async (variantKey: string) => {
      const [lv] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
        location_id: fx.quarantineLocationId,
      });
      return lv ? Number(lv.stocked_quantity) : 0;
    };
    const guardObjects = async () => {
      const triggers = (
        await pg().raw(
          `select c.relname as "table", t.tgname, t.tgdeferrable, t.tginitdeferred, t.tgconstraint <> 0 as is_constraint
             from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where t.tgrelid in ('inventory_level'::regclass, 'reservation_item'::regclass) and not t.tgisinternal
            order by t.tgname`,
        )
      ).rows as Array<{
        table: string;
        tgname: string;
        tgdeferrable: boolean;
        tginitdeferred: boolean;
        is_constraint: boolean;
      }>;
      const fns = (await pg().raw(`select proname from pg_proc where proname = ?`, [GUARD])).rows.length;
      return { triggers, fns };
    };
    const runMigration = async (direction: "up" | "down") => {
      // Migration của MikroORM chỉ gom câu SQL (addSql) — chạy chúng trên kết nối test.
      const m = new Migration20261028150000({} as never, {} as never);
      await m[direction]();
      for (const q of m.getQueries()) await pg().raw(String(q));
    };
    /** Một dòng reservation_item ghi thẳng (không qua Medusa, không cập nhật reserved_quantity của level). */
    const rawReservation = (variantKey: string, quantity: number, tag: string) => ({
      id: `resitem_t185_${tag}`,
      inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
      location_id: fx.sellableLocationId,
      quantity,
      description: "T-185",
    });
    const liveReservations = async (variantKey: string) =>
      (
        await pg()("reservation_item")
          .where({
            inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
            location_id: fx.sellableLocationId,
          })
          .whereNull("deleted_at")
      ).length;
    /** Gate dùng cho hai phiên DB chạy xen kẽ. */
    const latch = () => {
      let open!: () => void;
      const p = new Promise<void>((r) => (open = r));
      return { p, open };
    };
    const allowBackorder = (variantKey: string) =>
      updateProductVariantsWorkflow(container).run({
        input: { selector: { id: fx.variants[variantKey]!.id }, update: { allow_backorder: true } },
      });
    const lineOf = async (orderId: string, variantKey: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "items.id", "items.variant_id"],
        filters: { id: orderId },
      });
      const items = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items;
      return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
    };
    let tick = 0;
    const nextTime = () => new Date(Date.UTC(2026, 9, 28, 3, 0, 0) + ++tick * 60_000).toISOString();
    /** Hãng đổi trạng thái (API tra cứu trả trạng thái này) rồi gửi callback. */
    const provider = async (code: string, status: string): Promise<J> => {
      ghn.setStatusByOrderCode(code, status);
      const r = (await api.post(
        "/x/webhooks/shipping/ghn",
        { OrderCode: code, Type: "Switch_status", Status: status, Time: nextTime(), CODAmount: 0 },
        { validateStatus: () => true },
      )) as Res<J>;
      expect(r.status).toBe(200);
      return r.data;
    };
    const createShipment = async (o: PlacedOrder): Promise<string> => {
      const r = await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("order_staff"));
      expect(r.status).toBe(201);
      return r.data.shipment.provider_order_code as string;
    };
    const carrierReturns = async (orderId: string) =>
      (await returns().listReturnsOfOrder(orderId)).filter((r) => r.idempotency_key.startsWith("carrier:"));
    const adjust = (body: Record<string, unknown>, role: keyof typeof staff = "warehouse") =>
      flow.admin("/admin/x/inventory/adjustments", A(role), body, { "idempotency-key": key() });

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "owner"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, { stock: { "Đen/S": 1, "Đen/M": 10, "Trắng/S": 10, "Trắng/M": 10 } });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      ip = newIp();
    });

    /* ------------------------------------------------------------------ ràng buộc trong DB */

    describe("ràng buộc trong DB", () => {
      it("constraint trigger DEFERRABLE INITIALLY DEFERRED tồn tại trên inventory_level và reservation_item, kèm function", async () => {
        expect(await guardObjects()).toEqual({
          triggers: TRIGGERS.map((t) => ({
            ...t,
            tgdeferrable: true,
            tginitdeferred: true,
            is_constraint: true,
          })),
          fns: 1,
        });
      });

      it("ghi trực tiếp reserved > stocked: câu lệnh chạy được, bị từ chối LÚC COMMIT (23514, tên ràng buộc), dữ liệu không đổi", async () => {
        const before = await levelRow("Đen/M");
        let statementOk = false;
        const err = await pg()
          .transaction(async (trx) => {
            await trx("inventory_level").where({ id: before.id }).update({ reserved_quantity: 11 });
            statementOk = true;
            // Vẫn trong transaction: câu lệnh sau vẫn chạy (chưa kiểm).
            await trx.raw("select 1");
          })
          .then(
            () => null,
            (e: { code?: string; constraint?: string; message?: string }) => e,
          );
        expect(statementOk).toBe(true);
        expect(err?.code).toBe(CHECK_VIOLATION);
        expect(err?.constraint).toBe(GUARD);
        expect(err?.message).toContain(`${GUARD}:`);
        expect(err?.message).toContain(before.id);
        expect(await levelRow("Đen/M")).toEqual(before);
      });

      it("autocommit: stocked < reserved, reserved âm, stocked âm, INSERT vi phạm → 23514; đúng biên stocked = reserved → được", async () => {
        const { id } = await levelRow("Đen/M");
        const upd = (v: Record<string, number>) => outcome(pg()("inventory_level").where({ id }).update(v));
        expect(await upd({ stocked_quantity: 10, reserved_quantity: 11 })).toBe(CHECK_VIOLATION);
        expect(await upd({ reserved_quantity: -1 })).toBe(CHECK_VIOLATION);
        expect(await upd({ stocked_quantity: -1, reserved_quantity: 0 })).toBe(CHECK_VIOLATION);
        expect(await upd({ stocked_quantity: 0, reserved_quantity: 0 })).toBe("ok");
        expect(await upd({ stocked_quantity: 10, reserved_quantity: 10 })).toBe("ok");
        expect(await upd({ stocked_quantity: 10, reserved_quantity: 0 })).toBe("ok");
        const loc = (
          await container.resolve(Modules.STOCK_LOCATION).createStockLocations([{ name: "Kho T-185" }])
        )[0]!;
        const ins = await outcome(
          pg()("inventory_level").insert({
            id: "ilev_t185_bad",
            inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId,
            location_id: loc.id,
            stocked_quantity: 0,
            reserved_quantity: 1,
          }),
        );
        expect(ins).toBe(CHECK_VIOLATION);
        expect(await pg()("inventory_level").where({ id: "ilev_t185_bad" }).first()).toBeUndefined();
      });

      it("trạng thái trung gian trong cùng transaction (giữ trước, nhập sau; trừ rồi cộng lại) → commit được", async () => {
        const { id } = await levelRow("Đen/S"); // 1 / 0
        await pg().transaction(async (trx) => {
          await trx("inventory_level").where({ id }).update({ reserved_quantity: 3 }); // 1 < 3 (tạm)
          await trx("inventory_level").where({ id }).update({ stocked_quantity: 3 }); // 3 = 3
        });
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 3, reserved: 3 });
        await pg().transaction(async (trx) => {
          await trx("inventory_level").where({ id }).update({ stocked_quantity: 0 }); // 0 < 3 (tạm)
          await trx("inventory_level").where({ id }).update({ stocked_quantity: 5 });
        });
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 5, reserved: 3 });
      });

      it("dòng đã xoá mềm không bị kiểm; khôi phục dòng đang lệch → 23514", async () => {
        const { id } = await levelRow("Trắng/M");
        await pg()("inventory_level").where({ id }).update({ deleted_at: new Date() });
        expect(await outcome(pg()("inventory_level").where({ id }).update({ reserved_quantity: 99 }))).toBe(
          "ok",
        );
        expect(await outcome(pg()("inventory_level").where({ id }).update({ deleted_at: null }))).toBe(
          CHECK_VIOLATION,
        );
      });

      it("đồng thời: phiên A giữ +1 (chưa commit), phiên B hạ stocked về 0 (chờ khóa dòng) → A commit được, B bị từ chối lúc commit", async () => {
        const { id } = await levelRow("Đen/S"); // 1 / 0
        let releaseA!: () => void;
        const gate = new Promise<void>((r) => (releaseA = r));
        let aUpdated!: () => void;
        const updated = new Promise<void>((r) => (aUpdated = r));
        const a = outcome(
          pg().transaction(async (trx) => {
            await trx.raw(
              `update inventory_level set reserved_quantity = reserved_quantity + 1 where id = ?`,
              [id],
            );
            aUpdated();
            await gate;
          }),
        );
        await updated;
        let bDone = false;
        const b = outcome(
          pg().transaction(async (trx) => {
            // Như ghi tuyệt đối của Medusa (`stocked = đọc + Δ` với số đọc cũ): chỉ đặt cột stocked.
            await trx("inventory_level").where({ id }).update({ stocked_quantity: 0 });
          }),
        ).finally(() => (bDone = true));
        await sleep(300);
        expect(bDone).toBe(false); // B đang chờ khóa dòng của A
        releaseA();
        expect(await a).toBe("ok");
        expect(await b).toBe(CHECK_VIOLATION);
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 1, reserved: 1 });
      });

      it("down gỡ sạch trigger + function (ghi vi phạm lọt); up khi còn dòng lệch → dừng kèm số dòng, KHÔNG sửa dữ liệu; sửa rồi up lại được, chạy lặp không lỗi", async () => {
        const { id } = await levelRow("Trắng/S");
        try {
          await runMigration("down");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          expect(await outcome(pg()("inventory_level").where({ id }).update({ reserved_quantity: 12 }))).toBe(
            "ok",
          );
          const up = await runMigration("up").then(
            () => null,
            (e: { code?: string; message?: string }) => e,
          );
          expect(up?.code).toBe(CHECK_VIOLATION);
          expect(up?.message).toContain("T-185: 1 dòng inventory_level vi phạm");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          expect(await levelRow("Trắng/S")).toMatchObject({ stocked: 10, reserved: 12 }); // không tự sửa
          await pg()("inventory_level").where({ id }).update({ reserved_quantity: 0 });
          // D-134: tổng reservation_item còn sống vượt stocked (cột reserved vẫn khớp stocked) → up cũng dừng.
          await pg()("reservation_item").insert(rawReservation("Trắng/S", 11, "down"));
          const up2 = await runMigration("up").then(
            () => null,
            (e: { code?: string; message?: string }) => e,
          );
          expect(up2?.message).toContain("T-185: 1 dòng inventory_level vi phạm");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          await pg()("reservation_item").where({ id: "resitem_t185_down" }).delete();
        } finally {
          await runMigration("up");
        }
        expect((await guardObjects()).triggers.map((t) => t.tgname)).toEqual(TRIGGERS.map((t) => t.tgname));
        expect(await outcome(pg()("inventory_level").where({ id }).update({ reserved_quantity: 12 }))).toBe(
          CHECK_VIOLATION,
        );
        await runMigration("up");
        expect(await guardObjects()).toMatchObject({ fns: 1 });
      });
    });

    /* ------------------------------------------------------------------ D-134: tổng reservation_item */

    describe("D-134: stocked ≥ tổng reservation_item còn sống", () => {
      it("lost-update kiểu Medusa: hai phiên cùng đọc reserved = 0, mỗi phiên thêm reservation_item và ghi reserved = 0 + 1 (không khóa Redis) → phiên sau bị từ chối lúc commit; không bán âm", async () => {
        const { id } = await levelRow("Đen/S"); // 1 / 0
        const read = [latch(), latch()];
        const bothRead = Promise.all(read.map((l) => l.p));
        const session = (n: number) =>
          outcome(
            pg().transaction(async (trx) => {
              const row = await trx("inventory_level").where({ id }).first<{ reserved_quantity: string }>();
              read[n]!.open();
              await bothRead; // cả hai đã đọc số cũ
              await trx("reservation_item").insert(rawReservation("Đen/S", 1, `lu${n}`));
              // Ghi tuyệt đối từ số đã đọc (như inventory module của Medusa) — phiên sau chờ khóa dòng rồi GHI ĐÈ.
              await trx("inventory_level")
                .where({ id })
                .update({ reserved_quantity: Number(row!.reserved_quantity) + 1 });
            }),
          );
        const results = await Promise.all([session(0), session(1)]);
        expect(results.sort()).toEqual([CHECK_VIOLATION, "ok"]);
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 1, reserved: 1 });
        expect(await liveReservations("Đen/S")).toBe(1);
      });

      it("hai phiên chỉ chèn reservation_item (không chạm inventory_level), commit cùng lúc → đúng một phiên lọt (khóa dòng level trong hàm trigger tuần tự hoá)", async () => {
        const inserted = [latch(), latch()];
        const go = latch();
        const session = (n: number) =>
          outcome(
            pg().transaction(async (trx) => {
              await trx("reservation_item").insert(rawReservation("Đen/S", 1, `ins${n}`));
              inserted[n]!.open();
              await go.p;
            }),
          );
        const runs = [session(0), session(1)];
        await Promise.all(inserted.map((l) => l.p));
        go.open();
        expect((await Promise.all(runs)).sort()).toEqual([CHECK_VIOLATION, "ok"]);
        expect(await liveReservations("Đen/S")).toBe(1);
      });

      it("một phiên: chèn reservation vượt stocked → 23514; tăng quantity, khôi phục reservation đã xoá mềm, chuyển sang SKU/kho đã đầy → 23514; đúng biên → được", async () => {
        expect(await outcome(pg()("reservation_item").insert(rawReservation("Đen/S", 2, "big")))).toBe(
          CHECK_VIOLATION,
        );
        expect(await outcome(pg()("reservation_item").insert(rawReservation("Đen/S", 1, "one")))).toBe("ok");
        const one = pg()("reservation_item").where({ id: "resitem_t185_one" });
        expect(await outcome(one.clone().update({ quantity: 2 }))).toBe(CHECK_VIOLATION);
        expect(await outcome(one.clone().update({ deleted_at: new Date() }))).toBe("ok");
        expect(await outcome(pg()("reservation_item").insert(rawReservation("Đen/S", 1, "two")))).toBe("ok");
        expect(await outcome(one.clone().update({ deleted_at: null }))).toBe(CHECK_VIOLATION); // 2 > 1
        expect(await outcome(one.clone().update({ quantity: 5 }))).toBe("ok"); // còn xoá mềm → không tính
        // Chuyển reservation (Trắng/M, đủ hàng) sang Đen/S (đã giữ hết) → 23514.
        expect(await outcome(pg()("reservation_item").insert(rawReservation("Trắng/M", 1, "move")))).toBe(
          "ok",
        );
        expect(
          await outcome(
            pg()("reservation_item")
              .where({ id: "resitem_t185_move" })
              .update({ inventory_item_id: fx.variants["Đen/S"]!.inventoryItemId }),
          ),
        ).toBe(CHECK_VIOLATION);
        expect(await liveReservations("Đen/S")).toBe(1);
      });

      it("cột reserved_quantity bị ghi lệch nhỏ hơn tổng giữ: hạ stocked dưới tổng reservation (vẫn ≥ reserved) → 23514", async () => {
        await flow.client.placeOrder([["Đen/M", 3]], "vnpay"); // 10 / 3, tổng giữ 3
        const { id } = await levelRow("Đen/M");
        const r = await outcome(
          pg().transaction(async (trx) => {
            await trx("inventory_level").where({ id }).update({ reserved_quantity: 0 });
            await trx("inventory_level").where({ id }).update({ stocked_quantity: 2 }); // 2 ≥ 0 nhưng < 3
          }),
        );
        expect(r).toBe(CHECK_VIOLATION);
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 10, reserved: 3 });
      });

      it("đồng thời: phiên A chèn reservation (chưa commit), phiên B hạ stocked đúng bằng reserved cũ → một trong hai bị từ chối", async () => {
        const { id } = await levelRow("Đen/M"); // 10 / 0
        const aInserted = latch();
        const releaseA = latch();
        const a = outcome(
          pg().transaction(async (trx) => {
            await trx("reservation_item").insert(rawReservation("Đen/M", 1, "a"));
            aInserted.open();
            await releaseA.p;
          }),
        );
        await aInserted.p;
        const b = outcome(
          pg().transaction(async (trx) => {
            await trx("inventory_level").where({ id }).update({ stocked_quantity: 0 });
          }),
        );
        releaseA.open();
        expect([await a, await b].sort()).toEqual([CHECK_VIOLATION, "ok"]);
        const after = await levelRow("Đen/M");
        expect(after.stocked >= (await liveReservations("Đen/M"))).toBe(true);
      });
    });

    /* ------------------------------------------------------------------ checkout */

    describe("checkout", () => {
      it("đồng thời: hai checkout tranh đơn vị cuối → một 200, một 409 INSUFFICIENT_STOCK; reserved = stocked = 1", async () => {
        const carts = await Promise.all([
          flow.client.createCart([["Đen/S", 1]]),
          flow.client.createCart([["Đen/S", 1]]),
        ]);
        const quotes = await Promise.all(carts.map((c) => flow.client.quote(c)));
        const orders0 = await countOrders(container);
        const res = await Promise.all(quotes.map((q) => flow.client.submit(q)));
        expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(res.find((r) => r.status === 409)!.data.code).toBe("INSUFFICIENT_STOCK");
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 1, reserved: 1 });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
        expect(await countOrders(container)).toBe(orders0 + 1);
      });

      // D-133: hàng rào chặn MỌI giữ hàng vượt tồn, kể cả biến thể bật allow_backorder — backorder thực tế TẮT theo D-133.
      it("hàng rào DB quyết định (backorder bỏ qua kiểm tồn của ứng dụng và Medusa; backorder thực tế tắt theo D-133): hai checkout đồng thời tranh đơn vị cuối → một 200, một 409 INSUFFICIENT_STOCK (không 500), không bán âm", async () => {
        await allowBackorder("Đen/S");
        const carts = await Promise.all([
          flow.client.createCart([["Đen/S", 1]]),
          flow.client.createCart([["Đen/S", 1]]),
        ]);
        const quotes = await Promise.all(carts.map((c) => flow.client.quote(c)));
        const orders0 = await countOrders(container);
        const res = await Promise.all(quotes.map((q) => flow.client.submit(q)));
        expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
        const lostIdx = res.findIndex((r) => r.status === 409);
        expect(res[lostIdx]!.data.code).toBe("INSUFFICIENT_STOCK");
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 1, reserved: 1 });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
        expect(await countOrders(container)).toBe(orders0 + 1);
        // Attempt thua ghi mã nghiệp vụ (gửi lại cùng key không giữ hàng lần hai), không INTERNAL.
        const attempts = await checkout().listCheckoutAttempts({ cart_id: carts[lostIdx]! });
        expect(attempts.map((a) => ({ state: a.state, code: a.error_code }))).toEqual([
          { state: "failed", code: "INSUFFICIENT_STOCK" },
        ]);
      });

      it("VNPAY giữ hàng rồi hết hạn → nhả reservation (reserved về 0) qua job expire-holds", async () => {
        const o = await flow.client.placeOrder([["Đen/M", 2]], "vnpay");
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 2 });
        const r = await expireHolds(container, { now: new Date(Date.now() + 16 * MIN) });
        expect(r.cancelled).toContain(o.orderId);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });
      });
    });

    /* ------------------------------------------------------------------ điều chỉnh tồn */

    describe("điều chỉnh tồn (admin)", () => {
      it("route dự án: giảm đúng tới số đang giữ → 201; kho được phép, CSKH bị từ chối 403", async () => {
        await flow.client.placeOrder([["Đen/M", 4]], "vnpay"); // 10 / 4
        const body = {
          inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId,
          location_id: fx.sellableLocationId,
          delta: -6,
          reason: "damaged",
        };
        expect((await adjust(body, "support")).status).toBe(403);
        const ok = await adjust(body);
        expect(ok.status).toBe(201);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 4, reserved: 4 });
        const below = await adjust({ ...body, delta: -1 });
        expect(below.status).toBe(409);
        expect(below.data.code).toBe("BELOW_RESERVED");
      });

      it("đọc tồn cũ (số giữ tăng sau lúc đọc) → hàng rào DB chặn lúc ghi → 409 BELOW_RESERVED với số mới, tồn không đổi, không ghi sổ", async () => {
        await flow.client.placeOrder([["Đen/M", 8]], "vnpay"); // 10 / 8
        const inventory = container.resolve(Modules.INVENTORY);
        const real = inventory.listInventoryLevels.bind(inventory);
        const spy = jest.spyOn(inventory, "listInventoryLevels").mockImplementationOnce(async (...args) => {
          const rows = await real(...(args as Parameters<typeof real>));
          return rows.map((r) => ({ ...r, reserved_quantity: 0 })) as typeof rows; // số giữ cũ
        });
        try {
          const res = await adjust({
            inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId,
            location_id: fx.sellableLocationId,
            delta: -5,
            reason: "damaged",
          });
          expect(res.status).toBe(409);
          expect(res.data).toMatchObject({
            code: "BELOW_RESERVED",
            stocked_quantity: 10,
            reserved_quantity: 8,
            max_decrease: 2,
          });
        } finally {
          spy.mockRestore();
        }
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 8 });
      });

      it("route native /admin/inventory-items/:id/location-levels/:loc hạ stocked dưới số giữ → 409 INSUFFICIENT_STOCK (không 500); hợp lệ → 200; vai trò kho bị từ chối 403", async () => {
        await flow.client.placeOrder([["Đen/M", 3]], "vnpay"); // 10 / 3
        const url = `/admin/inventory-items/${fx.variants["Đen/M"]!.inventoryItemId}/location-levels/${fx.sellableLocationId}`;
        expect((await flow.admin(url, A("warehouse"), { stocked_quantity: 2 })).status).toBe(403);
        const bad = await flow.admin(url, A("owner"), { stocked_quantity: 2 });
        expect(bad.status).toBe(409);
        expect(bad.data.code).toBe("INSUFFICIENT_STOCK");
        expect(JSON.stringify(bad.data)).not.toMatch(/ilev_|x_inventory|stocked_quantity=/);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 3 });
        const ok = await flow.admin(url, A("owner"), { stocked_quantity: 3 });
        expect(ok.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 3, reserved: 3 });
      });

      it("setStock của fixture (updateInventoryLevelsWorkflow) dưới số giữ → bị từ chối, tồn không đổi", async () => {
        await flow.client.placeOrder([["Đen/M", 3]], "vnpay");
        const err = await setStock(container, fx, "Đen/M", 2).then(
          () => null,
          (e: { code?: string; constraint?: string }) => e,
        );
        expect({ code: err?.code, constraint: err?.constraint }).toEqual({
          code: CHECK_VIOLATION,
          constraint: GUARD,
        });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 3 });
      });
    });

    /* ------------------------------------------------------------------ xuất kho, GHN hủy/hoàn, đổi trả */

    describe("xuất kho, GHN hủy/hoàn, đổi trả", () => {
      it("COD: xuất kho khi tạo vận đơn (nhả giữ + trừ tồn) → GHN hủy trước lấy hàng → cách ly → kiểm định đạt → về kho bán", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 1 });
        const code = await createShipment(o);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        const c = await provider(code, "cancel");
        expect(c.carrier).toMatchObject({ outcome: "cancelled", order_cancelled: true });
        expect(await quarantine("Đen/M")).toBe(1);
        const [ret] = await carrierReturns(o.orderId);
        const line = await lineOf(o.orderId, "Đen/M");
        const ok = await flow.admin(`/admin/x/returns/${ret!.id}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(ok.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(0);
      });

      it("GHN hoàn về người gửi (delivering → delivery_fail → returned) → đơn hủy, hàng vào cách ly, tồn bán không đổi", async () => {
        const o = await flow.place([["Trắng/S", 2]], "cod");
        const code = await createShipment(o);
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 8, reserved: 0 });
        await provider(code, "delivering");
        await provider(code, "delivery_fail");
        const r = await provider(code, "returned");
        expect(r.carrier).toMatchObject({ outcome: "returned", order_cancelled: true });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 8, reserved: 0 });
        expect(await quarantine("Trắng/S")).toBe(2);
      });

      it("khách trả hàng sau giao: duyệt → nhận (cách ly) → kiểm định đạt → cộng tồn bán", async () => {
        const o = await flow.deliveredOrder([["Trắng/M", 1]], "cod");
        expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 9, reserved: 0 });
        const line = await lineOf(o.orderId, "Trắng/M");
        const req = await flow.requestReturn(o, {
          kind: "return",
          reason: "changed_mind",
          lines: [{ line_id: line, quantity: 1 }],
        });
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
        expect(await quarantine("Trắng/M")).toBe(1);
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 10, reserved: 0 });
        expect(await quarantine("Trắng/M")).toBe(0);
      });

      it("đổi size: duyệt → đơn thay thế giữ hàng size mới (+1 reserved); size mới đã giữ hết + backorder (D-133) → hàng rào DB chặn → 409 INSUFFICIENT_STOCK, không 500, không giữ thêm", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const exchange = () =>
          flow.requestReturn(o, {
            kind: "exchange",
            reason: "wrong_size",
            lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/M"]!.id }],
          });
        const req = await exchange();
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;

        // Size mới đã giữ hết cho đơn khác; backorder bỏ qua kiểm tồn của ứng dụng → chỉ còn hàng rào DB.
        await flow.client.placeOrder([["Đen/M", 10]], "vnpay"); // 10 / 10
        await allowBackorder("Đen/M");
        const orders0 = await countOrders(container);
        const blocked = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        expect(blocked).toMatchObject({ status: 409, data: { code: "INSUFFICIENT_STOCK" } });
        expect((await returns().getReturn(retId))!.state).toBe("requested");
        expect(await countOrders(container)).toBe(orders0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 10 });
        expect(await liveReservations("Đen/M")).toBe(1);

        // Còn hàng → duyệt được, giữ +1.
        await setStock(container, fx, "Đen/M", 11);
        const ok = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        expect(ok.status).toBe(200);
        expect(ok.data.return.replacement_order_id).toBeTruthy();
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 11, reserved: 11 });
      });

      it("xuất kho đọc tồn cũ (ghi khác chen giữa lúc kiểm và lúc trừ) → hàng rào DB chặn trừ tồn → 409 FULFILLMENT_BLOCKED (không 500), stocked không đổi", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod"); // 10 / 1
        await flow.client.placeOrder([["Đen/M", 9]], "vnpay"); // 10 / 10
        const inventory = container.resolve(Modules.INVENTORY);
        const real = inventory.listInventoryLevels.bind(inventory);
        // Chỉ lời đọc của applyStock thấy số cũ (stocked 9, reserved 8) → kiểm của ứng dụng cho qua, trừ về 8 < 9 đang giữ.
        const spy = jest.spyOn(inventory, "listInventoryLevels").mockImplementation(async (...args) => {
          const rows = await real(...(args as Parameters<typeof real>));
          if (!new Error().stack?.includes("applyStock")) return rows;
          return rows.map((r) => ({ ...r, stocked_quantity: 9, reserved_quantity: 8 })) as typeof rows;
        });
        try {
          const r = await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("order_staff"));
          expect(r.status).toBe(409);
          expect(r.data.code).toBe("FULFILLMENT_BLOCKED");
        } finally {
          spy.mockRestore();
        }
        expect((await inventoryLevel(container, fx, "Đen/M")).stocked).toBe(10);
      });
    });
  },
});
