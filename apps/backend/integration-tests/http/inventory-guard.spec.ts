import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { expireHolds } from "../../src/lib/checkout/jobs";
import { acquireOrdered, lockKeys, releaseOwned } from "../../src/lib/checkout/locks";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { INVENTORY_GUARD_CONSTRAINT, inventoryGuardKind } from "../../src/lib/inventory/guard";
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
/** Năm constraint trigger: inventory_level + reservation_item, mỗi sự kiện một trigger để WHEN dùng được OLD/NEW. */
const TRIGGERS = [
  { table: "inventory_level", tgname: `${GUARD}_ins` },
  { table: "inventory_level", tgname: `${GUARD}_upd` },
  { table: "reservation_item", tgname: "x_reservation_item_stock_guard_del" },
  { table: "reservation_item", tgname: "x_reservation_item_stock_guard_ins" },
  { table: "reservation_item", tgname: "x_reservation_item_stock_guard_upd" },
];
const CHECK_VIOLATION = "23514";
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * T-185 (Q-13, RK-001, IND-ECOM-001; D-133, D-134, review T-185) — hàng rào DB cho tồn kho: constraint trigger
 * `DEFERRABLE INITIALLY DEFERRED` trên `inventory_level` và `reservation_item` (migration checkout Migration20261028150000)
 * từ chối LÚC COMMIT mọi dòng level còn sống không giữ `0 <= reserved_quantity = Σ reservation_item còn sống <= stocked`
 * (vế `stock` → 409 hết hàng; vế `drift` — số giữ bị ghi đè đồng thời → 409 thử lại). Ghi trực tiếp vi phạm bị từ chối; trạng thái trung gian trong cùng
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
      const fns = (
        await pg().raw(`select proname from pg_proc where proname in (?, ?)`, [
          GUARD,
          "x_inventory_stock_check",
        ])
      ).rows.length;
      return { triggers, fns };
    };
    const runMigration = async (direction: "up" | "down") => {
      // Migration của MikroORM chỉ gom câu SQL (addSql) — chạy chúng trên kết nối test.
      const m = new Migration20261028150000({} as never, {} as never);
      await m[direction]();
      for (const q of m.getQueries()) await pg().raw(String(q));
    };
    /** Vế hàng rào mà lời ghi vi phạm ("stock" | "drift"), "ok", hoặc mã lỗi khác. */
    const verdict = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => "ok",
        (e: unknown) => inventoryGuardKind(e) ?? `other:${(e as { code?: string }).code ?? String(e)}`,
      );
    const pairOf = (variantKey: string) => ({
      inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
      location_id: fx.sellableLocationId,
    });
    /** Giữ hàng ghi thẳng NHẤT QUÁN như Medusa: thêm reservation_item + cộng reserved_quantity trong cùng transaction. */
    const reserveIn = async (trx: Knex.Transaction, variantKey: string, quantity: number, tag: string) => {
      await trx("reservation_item").insert(rawReservation(variantKey, quantity, tag));
      await trx("inventory_level")
        .where(pairOf(variantKey))
        .whereNull("deleted_at")
        .increment("reserved_quantity", quantity);
    };
    const reserve = (variantKey: string, quantity: number, tag: string) =>
      verdict(pg().transaction((trx) => reserveIn(trx, variantKey, quantity, tag)));
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
      it("năm constraint trigger DEFERRABLE INITIALLY DEFERRED trên inventory_level và reservation_item, kèm hai function", async () => {
        expect(await guardObjects()).toEqual({
          triggers: TRIGGERS.map((t) => ({
            ...t,
            tgdeferrable: true,
            tginitdeferred: true,
            is_constraint: true,
          })),
          fns: 2,
        });
      });

      it("ghi trực tiếp reserved > stocked: câu lệnh chạy được, bị từ chối LÚC COMMIT (23514, vế stock), dữ liệu không đổi", async () => {
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

      it("autocommit: stocked < reserved, số âm, INSERT vượt → stock; reserved ≠ tổng reservation → drift; đúng biên (giữ = tồn) → được", async () => {
        const { id } = await levelRow("Đen/M"); // 10 / 0, không reservation
        const upd = (v: Record<string, number>) => verdict(pg()("inventory_level").where({ id }).update(v));
        expect(await upd({ stocked_quantity: 10, reserved_quantity: 11 })).toBe("stock");
        expect(await upd({ reserved_quantity: -1 })).toBe("stock");
        expect(await upd({ stocked_quantity: -1, reserved_quantity: 0 })).toBe("stock");
        expect(await upd({ reserved_quantity: 1 })).toBe("drift"); // cột đếm lệch sổ reservation
        expect(await upd({ stocked_quantity: 0 })).toBe("ok");
        expect(await upd({ stocked_quantity: 10 })).toBe("ok");
        expect(await reserve("Đen/M", 10, "full")).toBe("ok"); // 10 / 10 — đúng biên
        expect(await reserve("Đen/M", 1, "over")).toBe("stock");
        expect(await levelRow("Đen/M")).toMatchObject({
          stocked: 10,
          reserved: 10,
        });
        const loc = (
          await container.resolve(Modules.STOCK_LOCATION).createStockLocations([{ name: "Kho T-185" }])
        )[0]!;
        const newLevel = (tag: string, stocked: number, reserved: number) =>
          verdict(
            pg()("inventory_level").insert({
              id: `ilev_t185_${tag}`,
              inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId,
              location_id: loc.id,
              stocked_quantity: stocked,
              reserved_quantity: reserved,
            }),
          );
        expect(await newLevel("bad", 0, 1)).toBe("stock");
        expect(await newLevel("drift", 5, 1)).toBe("drift");
        expect(await pg()("inventory_level").whereIn("id", ["ilev_t185_bad", "ilev_t185_drift"])).toEqual([]);
      });

      it("trạng thái trung gian trong cùng transaction (thêm reservation trước, cộng reserved sau, nhập sau; trừ rồi cộng lại) → commit được", async () => {
        const { id } = await levelRow("Đen/S"); // 1 / 0
        await pg().transaction(async (trx) => {
          await reserveIn(trx, "Đen/S", 3, "mid"); // 1 < 3 (tạm)
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
        expect(await verdict(pg()("inventory_level").where({ id }).update({ reserved_quantity: 99 }))).toBe(
          "ok",
        );
        expect(await verdict(pg()("inventory_level").where({ id }).update({ deleted_at: null }))).toBe(
          "stock",
        );
      });

      it("đồng thời: phiên A giữ +1 (chưa commit), phiên B hạ stocked về 0 (chờ khóa dòng) → A commit được, B bị từ chối lúc commit", async () => {
        const { id } = await levelRow("Đen/S"); // 1 / 0
        const releaseA = latch();
        const aReserved = latch();
        const a = verdict(
          pg().transaction(async (trx) => {
            await reserveIn(trx, "Đen/S", 1, "a");
            aReserved.open();
            await releaseA.p;
          }),
        );
        let bDone = false;
        let b: Promise<string> = Promise.resolve("not_started");
        try {
          await Promise.race([aReserved.p, a]); // A lỗi trước khi mở cổng → không chờ mãi
          b = verdict(
            pg().transaction(async (trx) => {
              // Như ghi tuyệt đối của Medusa (`stocked = đọc + Δ` với số đọc cũ): chỉ đặt cột stocked.
              await trx("inventory_level").where({ id }).update({ stocked_quantity: 0 });
            }),
          ).finally(() => (bDone = true));
          await sleep(300);
          expect(bDone).toBe(false); // B đang chờ khóa dòng của A
        } finally {
          // T-224: mở A cả khi assert trên đỏ — không để A (giữ khóa dòng) và B treo hook/test tới hết hạn 300 s.
          releaseA.open();
        }
        expect(await a).toBe("ok");
        expect(await b).toBe("stock");
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 1, reserved: 1 });
      });

      it("down gỡ sạch trigger + function (ghi vi phạm lọt); up khi còn dòng lệch (vượt tồn, tổng giữ vượt, drift) → dừng kèm số dòng, KHÔNG sửa dữ liệu; sửa rồi up lại được, chạy lặp không lỗi", async () => {
        const { id } = await levelRow("Trắng/S"); // 10 / 0
        const tryUp = () =>
          runMigration("up").then(
            () => null,
            (e: { code?: string; message?: string }) => e,
          );
        try {
          await runMigration("down");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          // (a) reserved > stocked
          expect(await verdict(pg()("inventory_level").where({ id }).update({ reserved_quantity: 12 }))).toBe(
            "ok",
          );
          const up = await tryUp();
          expect(up?.code).toBe(CHECK_VIOLATION);
          expect(up?.message).toContain("T-185: 1 dòng inventory_level vi phạm");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          expect(await levelRow("Trắng/S")).toMatchObject({
            stocked: 10,
            reserved: 12,
          }); // không tự sửa
          // (b) tổng reservation_item vượt stocked (cột reserved khớp sổ, reserved ≤ stocked nhờ nâng stocked tạm)
          await pg()("reservation_item").insert(rawReservation("Trắng/S", 11, "down"));
          await pg()("inventory_level").where({ id }).update({ reserved_quantity: 11, stocked_quantity: 11 });
          expect(await tryUp()).toBeNull(); // 11 / 11 / Σ 11 — hợp lệ
          await runMigration("down");
          await pg()("inventory_level").where({ id }).update({ reserved_quantity: 10, stocked_quantity: 10 });
          expect((await tryUp())?.message).toContain("T-185: 1 dòng inventory_level vi phạm"); // Σ 11 > 10
          await pg()("reservation_item").where({ id: "resitem_t185_down" }).delete();
          // (c) drift: reserved 1 nhưng không có reservation nào
          await pg()("inventory_level").where({ id }).update({ reserved_quantity: 1 });
          expect((await tryUp())?.message).toContain("T-185: 1 dòng inventory_level vi phạm");
          expect(await guardObjects()).toEqual({ triggers: [], fns: 0 });
          await pg()("inventory_level").where({ id }).update({ reserved_quantity: 0 });
        } finally {
          await runMigration("up");
        }
        expect((await guardObjects()).triggers.map((t) => t.tgname)).toEqual(TRIGGERS.map((t) => t.tgname));
        expect(await verdict(pg()("inventory_level").where({ id }).update({ reserved_quantity: 12 }))).toBe(
          "stock",
        );
        await runMigration("up");
        expect(await guardObjects()).toMatchObject({ fns: 2 });
      });
    });

    /* ------------------------------------------------------------------ D-134 + review T-185: sổ reservation */

    describe("D-134: stocked ≥ tổng reservation_item còn sống; reserved = tổng đó (review T-185)", () => {
      /** Hai phiên đọc reserved cũ rồi ghi tuyệt đối (như inventory module của Medusa), không khóa Redis. */
      const lostUpdate = async (variantKey: string) => {
        const { id } = await levelRow(variantKey);
        const read = [latch(), latch()];
        const bothRead = Promise.all(read.map((l) => l.p));
        const session = (n: number) =>
          verdict(
            pg().transaction(async (trx) => {
              const row = await trx("inventory_level").where({ id }).first<{ reserved_quantity: string }>();
              read[n]!.open();
              await bothRead; // cả hai đã đọc số cũ
              await trx("reservation_item").insert(rawReservation(variantKey, 1, `lu${n}`));
              // Phiên sau chờ khóa dòng rồi GHI ĐÈ bằng số đã đọc.
              await trx("inventory_level")
                .where({ id })
                .update({ reserved_quantity: Number(row!.reserved_quantity) + 1 });
            }),
          );
        return (await Promise.all([session(0), session(1)])).sort();
      };

      it("lost-update khi hết hàng (tồn 1): phiên ghi đè bị từ chối lúc commit (stock); không bán âm", async () => {
        expect(await lostUpdate("Đen/S")).toEqual(["ok", "stock"]);
        expect(await levelRow("Đen/S")).toMatchObject({ stocked: 1, reserved: 1 });
        expect(await liveReservations("Đen/S")).toBe(1);
      });

      it("RV-1 lost-update khi CÒN hàng (tồn 10): phiên ghi đè bị từ chối (drift); nhả mọi giữ hàng sau đó vẫn chạy, reserved về 0", async () => {
        expect(await lostUpdate("Trắng/S")).toEqual(["drift", "ok"]);
        expect(await levelRow("Trắng/S")).toMatchObject({
          stocked: 10,
          reserved: 1,
        });
        expect(await liveReservations("Trắng/S")).toBe(1);
        const ids = (await reservationsOf(container, fx, "Trắng/S")).map((r) => r.id);
        await container.resolve(Modules.INVENTORY).deleteReservationItems(ids);
        expect(await levelRow("Trắng/S")).toMatchObject({
          stocked: 10,
          reserved: 0,
        });
      });

      it("RV-5 hai createReservationItems đồng thời qua module service (không khóa), ×8: chỉ ok/drift, reserved luôn = tổng giữ, nhả được hết", async () => {
        const inventory = container.resolve(Modules.INVENTORY);
        const seen = new Set<string>();
        for (let i = 0; i < 8; i++) {
          const res = await Promise.all([
            verdict(
              inventory.createReservationItems({
                ...pairOf("Trắng/M"),
                quantity: 1,
              }),
            ),
            verdict(
              inventory.createReservationItems({
                ...pairOf("Trắng/M"),
                quantity: 1,
              }),
            ),
          ]);
          for (const r of res) seen.add(r);
          expect(res.every((r) => r === "ok" || r === "drift")).toBe(true);
          expect((await levelRow("Trắng/M")).reserved).toBe(await liveReservations("Trắng/M"));
          const ids = (await reservationsOf(container, fx, "Trắng/M")).map((r) => r.id);
          await inventory.deleteReservationItems(ids);
          expect(await levelRow("Trắng/M")).toMatchObject({
            stocked: 10,
            reserved: 0,
          });
        }
        expect(seen.has("ok")).toBe(true);
      });

      it("khóa dòng level trong hàm kiểm (FOR UPDATE): phiên B đổi sổ reservation không chạm level phải CHỜ phiên A (đã kiểm, chưa commit) rồi kiểm trên số của A", async () => {
        await setStock(container, fx, "Đen/M", 2);
        expect(await reserve("Đen/M", 1, "r0")).toBe("ok"); // 2 / 1
        const aChecked = latch();
        const releaseA = latch();
        const a = verdict(
          pg().transaction(async (trx) => {
            await reserveIn(trx, "Đen/M", 1, "a"); // 2 / 2
            await trx.raw("set constraints all immediate"); // kiểm ngay, giữ khóa dòng level tới commit
            aChecked.open();
            await releaseA.p;
          }),
        );
        let bDone = false;
        let b: Promise<string> = Promise.resolve("not_started");
        try {
          await Promise.race([aChecked.p, a]); // A lỗi trước khi mở cổng → không chờ mãi
          b = verdict(
            pg().transaction(async (trx) => {
              // Đổi reservation r0 lấy rB cùng số lượng: tổng không đổi, KHÔNG UPDATE dòng level (không tự lấy khóa dòng).
              await trx("reservation_item")
                .where({ id: "resitem_t185_r0" })
                .update({ deleted_at: new Date() });
              await trx("reservation_item").insert(rawReservation("Đen/M", 1, "b"));
              await trx.raw("set constraints all immediate");
            }),
          ).finally(() => (bDone = true));
          await sleep(1_000);
          expect(bDone).toBe(false); // chờ khóa dòng của A — bỏ FOR UPDATE thì B xong ngay
        } finally {
          // T-224: mở A cả khi assert trên đỏ (vd. bỏ FOR UPDATE) — không để A giữ khóa dòng, B và hook teardown treo 300 s.
          releaseA.open();
        }
        expect([await a, await b]).toEqual(["ok", "ok"]);
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 2, reserved: 2 });
        expect(await liveReservations("Đen/M")).toBe(2);
      });

      it("một phiên: giữ/tăng/khôi phục/chuyển vượt tồn → stock; đổi sổ reservation không đổi reserved (thêm, tăng, xoá mềm, xoá cứng) → drift; nhất quán → được", async () => {
        expect(await reserve("Đen/S", 2, "big")).toBe("stock");
        expect(await reserve("Đen/S", 1, "one")).toBe("ok"); // 1 / 1
        const res = (rid: string) => pg()("reservation_item").where({ id: `resitem_t185_${rid}` });
        const level = (k: string) => pg()("inventory_level").where(pairOf(k)).whereNull("deleted_at");
        // Tăng quantity kèm reserved → vượt tồn.
        expect(
          await verdict(
            pg().transaction(async (trx) => {
              await res("one").transacting(trx).update({ quantity: 2 });
              await level("Đen/S").transacting(trx).increment("reserved_quantity", 1);
            }),
          ),
        ).toBe("stock");
        // Xoá mềm kèm trừ reserved → được; giữ "two" → được; khôi phục "one" kèm cộng reserved → vượt tồn.
        const softDelete = (rid: string, k: string, at: Date | null, delta: number) =>
          verdict(
            pg().transaction(async (trx) => {
              await res(rid).transacting(trx).update({ deleted_at: at });
              await level(k).transacting(trx).increment("reserved_quantity", delta);
            }),
          );
        expect(await softDelete("one", "Đen/S", new Date(), -1)).toBe("ok");
        expect(await reserve("Đen/S", 1, "two")).toBe("ok");
        expect(await softDelete("one", "Đen/S", null, 1)).toBe("stock");
        // Chuyển reservation (Trắng/M, đủ hàng) sang Đen/S (đã giữ hết), cập nhật cả hai level → vượt tồn.
        expect(await reserve("Trắng/M", 1, "move")).toBe("ok");
        expect(
          await verdict(
            pg().transaction(async (trx) => {
              await res("move").transacting(trx).update({
                inventory_item_id: fx.variants["Đen/S"]!.inventoryItemId,
              });
              await level("Trắng/M").transacting(trx).increment("reserved_quantity", -1);
              await level("Đen/S").transacting(trx).increment("reserved_quantity", 1);
            }),
          ),
        ).toBe("stock");
        // Drift: đổi sổ reservation mà không đổi reserved (Trắng/M còn hàng — chỉ vế drift bắt được).
        expect(await verdict(pg()("reservation_item").insert(rawReservation("Trắng/M", 1, "raw")))).toBe(
          "drift",
        );
        expect(await verdict(res("move").update({ quantity: 2 }))).toBe("drift");
        expect(await verdict(res("move").update({ deleted_at: new Date() }))).toBe("drift");
        expect(await verdict(res("move").delete())).toBe("drift");
        expect(await levelRow("Trắng/M")).toMatchObject({
          stocked: 10,
          reserved: 1,
        });
        expect(await liveReservations("Đen/S")).toBe(1);
        expect(await liveReservations("Trắng/M")).toBe(1);
      });

      it("hạ stocked dưới tổng reservation (cột reserved bị ghi lệch thấp hơn) → stock", async () => {
        await flow.client.placeOrder([["Đen/M", 3]], "vnpay"); // 10 / 3, tổng giữ 3
        const { id } = await levelRow("Đen/M");
        const r = await verdict(
          pg().transaction(async (trx) => {
            await trx("inventory_level").where({ id }).update({ reserved_quantity: 0 });
            await trx("inventory_level").where({ id }).update({ stocked_quantity: 2 }); // 2 ≥ 0 nhưng < 3
          }),
        );
        expect(r).toBe("stock");
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 10, reserved: 3 });
      });
    });

    /* ------------------------------------------------------------------ job đối chiếu attempt */

    describe("reconcile-attempts: attempt bù trừ lỗi được hẹn lại, không đứng đầu hàng đợi (review T-185)", () => {
      it("COMPENSATING quá lease được liệt kê; deferStaleAttempt đẩy lease → không liệt kê tới khi tới hẹn; preparing không bị hẹn", async () => {
        const o = await flow.client.placeOrder([["Trắng/S", 1]], "cod");
        // Mốc tương lai (job nền chạy theo giờ thật không chạm attempt này).
        const t0 = new Date(Date.now() + 60 * MIN);
        const now = new Date(t0.getTime() + 60 * MIN);
        const ids = async (at: Date) => (await checkout().listStaleAttempts(at, 50)).map((a) => a.id);
        await pg()("checkout_attempt").where({ id: o.attemptId }).update({
          state: "compensated",
          error_code: "COMPENSATING",
          lease_until: t0,
        });
        expect(await ids(now)).toContain(o.attemptId);
        expect(await checkout().deferStaleAttempt(o.attemptId, new Date(now.getTime() + 5 * MIN))).toBe(true);
        expect(await ids(now)).not.toContain(o.attemptId);
        expect(await ids(new Date(now.getTime() + 6 * MIN))).toContain(o.attemptId);
        await pg()("checkout_attempt")
          .where({ id: o.attemptId })
          .update({ state: "preparing", error_code: null, lease_until: t0 });
        expect(await checkout().deferStaleAttempt(o.attemptId, new Date(now.getTime() + 5 * MIN))).toBe(
          false,
        );
        expect(await ids(now)).toContain(o.attemptId);
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

    /* ------------------------------------------------------------------ T-224: nhả giữ dưới khóa tồn */

    describe("T-224: đường nhả giữ lấy khóa inventory_item:* (không đua drift với đường giữ/ghi tồn cùng SKU)", () => {
      /**
       * Một đường ghi tồn CHỈ giữ khóa tiền tố `inventory_item:<id>` của dự án (như xuất kho trả lại reservation bằng
       * `restoreReservationItems` gọi thẳng module — không có khóa id thô của Medusa): đọc reserved, dừng tới khi `until`
       * xong (tối đa `holdMs`), rồi thêm một reservation và ghi reserved TUYỆT ĐỐI (`đọc + 1`) như module Medusa 2.22.1.
       */
      const prefixedWriter = async (
        variantKey: string,
        tag: string,
        read: { open: () => void },
        until: Promise<unknown>,
        holdMs: number,
      ) => {
        const locking = container.resolve(Modules.LOCKING);
        const owner = `t224:${tag}`;
        await acquireOrdered(locking, [lockKeys.inventoryItem(fx.variants[variantKey]!.inventoryItemId)], {
          ownerId: owner,
          waitMs: 5_000,
          ttlSeconds: 30,
          scope: "inventory",
        });
        try {
          const v = await verdict(
            pg().transaction(async (trx) => {
              const lv = await trx("inventory_level")
                .where(pairOf(variantKey))
                .whereNull("deleted_at")
                .first<{ id: string; reserved_quantity: string }>();
              read.open();
              await Promise.race([until, sleep(holdMs)]);
              await trx("reservation_item").insert(rawReservation(variantKey, 1, tag));
              await trx("inventory_level")
                .where({ id: lv!.id })
                .update({ reserved_quantity: Number(lv!.reserved_quantity) + 1 });
            }),
          );
          return { verdict: v, committedAt: Date.now() };
        } finally {
          await releaseOwned(locking, owner, null);
        }
      };
      /**
       * Chạy `release` (đường nhả giữ thật) chen vào giữa lúc `prefixedWriter` đã đọc và chưa ghi. Thiếu khóa tồn ở đường
       * nhả → nhả xong trước, phiên ghi ghi đè số giữ → `drift`. Có khóa → nhả chờ phiên ghi commit rồi mới chạy.
       */
      const raceRelease = async <T>(variantKey: string, tag: string, release: () => Promise<T>) => {
        const read = latch();
        const released = latch();
        let releasedAt = 0;
        const writer = prefixedWriter(variantKey, tag, read, released.p, 3_000);
        await Promise.race([read.p, writer]);
        const result = release().finally(() => {
          releasedAt = Date.now();
          released.open();
        });
        const [w, r] = await Promise.all([writer, result]);
        return { writer: w.verdict, result: r, releasedAfterWriter: releasedAt >= w.committedAt };
      };
      const staffCancel = (orderId: string) =>
        flow.admin(
          `/admin/x/orders/${orderId}/cancel`,
          A("order_staff"),
          { reason: "Khách gọi hotline xin hủy" },
          { "Idempotency-Key": key() },
        );

      it("hết hạn giữ (expire-holds → cancelNativeOrder) ∥ đường ghi giữ khóa tồn: nhả chờ khóa, không ai nhận drift, reserved = tổng giữ", async () => {
        const o = await flow.client.placeOrder([["Đen/M", 2]], "vnpay"); // 10 / 2
        const r = await raceRelease("Đen/M", "exp", () =>
          expireHolds(container, { now: new Date(Date.now() + 16 * MIN) }),
        );
        expect(r.writer).toBe("ok");
        expect(r.result.cancelled).toEqual([o.orderId]);
        expect(r.releasedAfterWriter).toBe(true);
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 10, reserved: 1 });
        expect(await liveReservations("Đen/M")).toBe(1);
      });

      it("nhân viên hủy đơn COD chưa thu (staff-cancel → cancelNativeOrder) ∥ đường ghi giữ khóa tồn: 200, không drift", async () => {
        const o = await flow.client.placeOrder([["Đen/M", 2]], "cod");
        const r = await raceRelease("Đen/M", "staff", () => staffCancel(o.orderId));
        expect(r.writer).toBe("ok");
        expect(r.result.status).toBe(200);
        expect(r.result.data.cancel).toMatchObject({ outcome: "cancelled", refund_requested: false });
        expect(r.releasedAfterWriter).toBe(true);
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 10, reserved: 1 });
        expect(await liveReservations("Đen/M")).toBe(1);
      });

      it("nhân viên hủy đơn VNPAY đã thu (releaseReservations, không hủy native) ∥ đường ghi giữ khóa tồn: 200, không drift", async () => {
        const o = await flow.place([["Đen/M", 2]], "vnpay");
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 2 });
        const r = await raceRelease("Đen/M", "paid", () => staffCancel(o.orderId));
        expect(r.writer).toBe("ok");
        expect(r.result.status).toBe(200);
        expect(r.result.data.cancel).toMatchObject({ outcome: "cancelled", refund_requested: true });
        expect(r.releasedAfterWriter).toBe(true);
        expect(await levelRow("Đen/M")).toMatchObject({ stocked: 10, reserved: 1 });
        expect(await liveReservations("Đen/M")).toBe(1);
      });

      it("tải thật ×3 vòng: hết hạn giữ + nhân viên hủy + checkout mới cùng SKU đồng thời → không 409 thử lại/drift, không treo, reserved = tổng giữ", async () => {
        for (let round = 0; round < 3; round++) {
          const expiring = await Promise.all(
            [0, 1].map(() => flow.client.placeOrder([["Trắng/M", 1]], "vnpay")),
          );
          const cod = await flow.client.placeOrder([["Trắng/M", 1]], "cod");
          ip = newIp();
          const carts = await Promise.all([0, 1].map(() => flow.client.createCart([["Trắng/M", 1]])));
          const quotes = await Promise.all(carts.map((c) => flow.client.quote(c)));
          const [exp, cancel, ...submits] = await Promise.all([
            expireHolds(container, { now: new Date(Date.now() + 16 * MIN) }),
            staffCancel(cod.orderId),
            ...quotes.map((q) => flow.client.submit(q)),
          ]);
          // Lượt hết hạn (now + 16 phút) gặp cả đơn checkout của vòng trước/vòng này → chỉ đòi có đủ đơn VNPAY cũ của vòng.
          expect(exp.cancelled).toEqual(expect.arrayContaining(expiring.map((o) => o.orderId)));
          expect(cancel.status).toBe(200);
          expect(submits.map((s) => s.status)).toEqual([200, 200]);
          const lv = await levelRow("Trắng/M");
          expect(lv.reserved).toBe(
            (await reservationsOf(container, fx, "Trắng/M")).reduce((n, r) => n + Number(r.quantity), 0),
          );
          expect(lv.reserved).toBeLessThanOrEqual(lv.stocked);
          ip = newIp();
        }
      });

      it("route native POST /admin/reservations/:id đổi location_id → 400 RESERVATION_LOCATION_CHANGE_UNSUPPORTED trước khi tới Medusa (tồn hai kho không đổi); cùng kho → 200; vai trò kho → 403; id không có → lỗi gốc của Medusa", async () => {
        await flow.client.placeOrder([["Đen/M", 2]], "vnpay"); // 10 / 2
        const [res] = await reservationsOf(container, fx, "Đen/M");
        const url = `/admin/reservations/${res!.id}`;
        // Kho đích có dòng tồn (5) — đúng ca lỗi gốc: Medusa cộng +q ở kho mới, bỏ −q ở kho cũ → hàng rào DB luôn từ chối.
        const inventory = container.resolve(Modules.INVENTORY);
        const target = {
          inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId,
          location_id: fx.quarantineLocationId,
        };
        if ((await inventory.listInventoryLevels(target)).length === 0) {
          await inventory.createInventoryLevels([{ ...target, stocked_quantity: 5 }]);
        }
        const before = await quarantine("Đen/M");
        // RBAC trước: kho (không có settings.manage) bị 403 kể cả khi đổi kho — không dò được reservation.
        expect((await flow.admin(url, A("warehouse"), { location_id: fx.quarantineLocationId })).status).toBe(
          403,
        );
        const bad = await flow.admin(url, A("owner"), { location_id: fx.quarantineLocationId });
        expect(bad.status).toBe(400);
        expect(bad.headers["content-type"]).toContain("application/problem+json");
        expect(bad.data).toMatchObject({
          code: "RESERVATION_LOCATION_CHANGE_UNSUPPORTED",
          errors: [{ param: "location_id", reason: "location_change_unsupported" }],
        });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 2 });
        expect(await quarantine("Đen/M")).toBe(before);
        const [after] = await reservationsOf(container, fx, "Đen/M");
        expect(after).toMatchObject({ id: res!.id, location_id: fx.sellableLocationId, quantity: 2 });
        // Cùng kho (kèm sửa mô tả) → route gốc chạy bình thường.
        const same = await flow.admin(url, A("owner"), {
          location_id: fx.sellableLocationId,
          description: "T-224 cùng kho",
        });
        expect(same.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 2 });
        // Reservation không tồn tại → cổng không chặn, route gốc trả lỗi của chính nó (Medusa 2.22.1: 400 "not found").
        const missing = await flow.admin("/admin/reservations/resitem_t224_none", A("owner"), {
          location_id: fx.quarantineLocationId,
        });
        expect(missing.status).toBeGreaterThanOrEqual(400);
        expect(missing.status).toBeLessThan(500);
        expect(missing.data.code).not.toBe("RESERVATION_LOCATION_CHANGE_UNSUPPORTED");
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

      it("xuất kho đọc tồn cũ (ghi khác chen giữa lúc kiểm và lúc trừ) → hàng rào DB chặn trừ tồn → 409 FULFILLMENT_BLOCKED (không 500), trả lại reservation đã nhả, stocked không đổi", async () => {
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
        // Không để trạng thái dở: reservation vừa nhả được trả lại, stocked chưa trừ (review T-185).
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 10 });
        expect(await liveReservations("Đen/M")).toBe(2);
        const line = await lineOf(o.orderId, "Đen/M");
        const mine = await container.resolve(Modules.INVENTORY).listReservationItems({ line_item_id: line });
        expect(mine.map((r) => Number(r.quantity))).toEqual([1]);
      });
    });
  },
});
