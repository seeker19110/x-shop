import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateInventoryLevelsWorkflow,
} from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { ensureNativeFulfillment } from "../../src/lib/shipping/fulfillment";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-045 — hàng hoàn từ hãng: GHN `cancel` (hủy trước lấy hàng) và hoàn về người gửi (`return…` → `returned`).
 * Hàng đã trừ tồn khi tạo vận đơn (T-043) về KHO CÁCH LY chờ kiểm định — tồn bán không đổi; kiểm định đạt → nhập lại
 * đúng kho đã xuất (nhiều kho), lỗi → ở lại cách ly. Đơn hủy theo máy trạng thái; COD chưa thu → không ghi thu/không hoàn;
 * VNPAY đã thu → yêu cầu hoàn chờ duyệt (D-012), không tự hoàn. Callback lặp/đồng thời → một lần; đã giao không lùi.
 * Luồng đơn thật qua HTTP (submit → IPN/xác nhận COD → vận đơn GHN mock → callback đã đối chiếu API hãng).
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let ghn: MockModeGhnClient;
    let ip = newIp();
    const staff = {} as Record<"order_staff" | "support" | "warehouse", MfaAdmin>;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);
    const shipping = () => container.resolve<ShippingModuleService>(SHIPPING_MODULE);
    const A = (role: keyof typeof staff) => staff[role].headers;

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse"] as const) {
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
      fx = await seedCatalog(container);
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      clearShippingFeeCache();
      ip = newIp();
    });

    /* ------------------------------------------------------------------ helpers */

    let tick = 0;
    /** Mỗi callback một mốc thời gian mới (khóa chống lặp gồm Time). */
    const nextTime = () => new Date(Date.UTC(2026, 9, 25, 3, 0, 0) + ++tick * 60_000).toISOString();
    const callback = (code: string, status: string, time = nextTime()): Promise<Res<J>> =>
      api.post(
        "/x/webhooks/shipping/ghn",
        { OrderCode: code, Type: "Switch_status", Status: status, Time: time, CODAmount: 0 },
        { validateStatus: () => true },
      ) as never;
    /** Hãng đổi trạng thái (API tra cứu trả trạng thái này) rồi gửi callback. */
    const provider = async (code: string, status: string, time?: string) => {
      ghn.setStatusByOrderCode(code, status);
      const r = await callback(code, status, time);
      expect(r.status).toBe(200);
      return r.data;
    };
    const createShipment = async (o: PlacedOrder): Promise<string> => {
      const r = (await api.post(
        `/admin/x/orders/${o.orderId}/shipments`,
        {},
        { headers: A("order_staff"), validateStatus: () => true },
      )) as Res<J>;
      expect(r.status).toBe(201);
      return r.data.shipment.provider_order_code as string;
    };
    const levelAt = async (variantKey: string, locationId: string) => {
      const [lv] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
        location_id: locationId,
      });
      return lv ? { stocked: Number(lv.stocked_quantity), reserved: Number(lv.reserved_quantity) } : null;
    };
    const quarantine = async (variantKey: string) =>
      (await levelAt(variantKey, fx.quarantineLocationId))?.stocked ?? 0;
    const finState = async (orderId: string) =>
      (await checkout().listOrderFinances({ order_id: orderId }))[0]!.state;
    const lineOf = async (orderId: string, variantKey: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "items.id", "items.variant_id"],
        filters: { id: orderId },
      });
      const items = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items;
      return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
    };
    const fulfillments = async (orderId: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "status", "fulfillments.id", "fulfillments.canceled_at", "fulfillments.shipped_at"],
        filters: { id: orderId },
      });
      const o = data[0] as {
        status: string;
        fulfillments: Array<{ id: string; canceled_at: string | null; shipped_at: string | null }>;
      };
      return { status: o.status, list: (o.fulfillments ?? []).filter(Boolean) };
    };
    const fulfillmentLedger = async (orderId: string) => {
      const ids = (await fulfillments(orderId)).list.map((f) => f.id);
      const rows = (
        await container
          .resolve(ContainerRegistrationKeys.PG_CONNECTION)
          .raw(
            `SELECT delta FROM inventory_adjustment WHERE reason = 'fulfillment' AND idempotency_key LIKE ?`,
            [`xful-${ids[0]}-%`],
          )
      ).rows as Array<{ delta: number }>;
      return rows;
    };
    const money = async (orderId: string) => ({
      ledger: (await checkout().listPaymentLedgers({ order_id: orderId })).map((l) => ({
        kind: l.kind,
        amount: Number(l.amount),
      })),
      refunds: await returns().listRefundsOfOrder(orderId),
      refundRequests: await checkout().listOpsExceptions({ order_id: orderId, kind: "refund_request" }),
    });
    const carrierReturns = async (orderId: string) =>
      (await returns().listReturnsOfOrder(orderId)).filter((r) => r.idempotency_key.startsWith("carrier:"));
    const view = async (o: PlacedOrder): Promise<J> => {
      const r = (await api.get(
        `/store/x/orders/${o.ref}`,
        flow.client.cfg({ "x-forwarded-for": ip, "x-order-access": o.access }),
      )) as Res<J>;
      expect(r.status).toBe(200);
      return r.data;
    };
    const inspect = (retId: string, role: keyof typeof staff, lines: unknown[]) =>
      flow.admin(`/admin/x/returns/${retId}/inspect`, A(role), { lines });

    /** Kho bán thứ hai gắn kênh bán (id lớn hơn Kho chính — kho mặc định theo id vẫn là Kho chính). */
    async function secondWarehouse(stock: Record<string, number>): Promise<string> {
      const { result } = await createStockLocationsWorkflow(container).run({
        input: { locations: [{ name: `Kho phụ ${Math.random().toString(36).slice(2, 8)}` }] },
      });
      const id = result[0]!.id;
      await linkSalesChannelsToStockLocationWorkflow(container).run({
        input: { id, add: [fx.salesChannelId] },
      });
      await createInventoryLevelsWorkflow(container).run({
        input: {
          inventory_levels: Object.entries(stock).map(([k, q]) => ({
            inventory_item_id: fx.variants[k]!.inventoryItemId,
            location_id: id,
            stocked_quantity: q,
          })),
        },
      });
      expect(id > fx.sellableLocationId).toBe(true);
      return id;
    }

    /* ------------------------------------------------------------------ hủy trước lấy hàng */

    describe("GHN cancel trước khi lấy hàng", () => {
      it("COD: đơn hủy, vận đơn về unfulfilled, KHÔNG trừ tồn lần hai; hàng vào cách ly; lặp → không đổi; kiểm định đạt → về kho bán", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        const code = await createShipment(o);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });

        const c1 = await provider(code, "cancel");
        expect(c1).toMatchObject({
          ok: true,
          state: "unfulfilled",
          native_sync: "skipped",
          carrier: {
            outcome: "cancelled",
            order_state: "cancelled",
            order_cancelled: true,
            paid: 0,
            refund_id: null,
            return_state: "received",
          },
        });
        expect(await finState(o.orderId)).toBe("cancelled");
        expect((await shipping().shipmentOfOrder(o.orderId))!.state).toBe("unfulfilled");
        // Tồn bán: trừ một lần lúc tạo vận đơn, không cộng lại tự động, không trừ thêm.
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(1);
        expect(await fulfillmentLedger(o.orderId)).toEqual([{ delta: -1 }]);
        const native = await fulfillments(o.orderId);
        expect(native.list).toHaveLength(1);
        expect(native.list[0]!.canceled_at).not.toBeNull();
        expect(native.status).toBe("canceled");
        // COD chưa thu: không ghi thu, không hoàn, không ngoại lệ hoàn tiền.
        expect(await money(o.orderId)).toEqual({ ledger: [], refunds: [], refundRequests: [] });
        expect(await view(o)).toMatchObject({ state: "cancelled", payment_state: "void" });

        // Callback lặp (mốc khác) → không đổi gì.
        const c2 = await provider(code, "cancel");
        expect(c2.carrier).toMatchObject({ order_cancelled: false, order_state: "cancelled" });
        expect(await carrierReturns(o.orderId)).toHaveLength(1);
        expect(await quarantine("Đen/M")).toBe(1);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });

        // Vận đơn đã hủy không "sống lại"; tạo lại vận đơn bị chặn; đồng bộ native trực tiếp không tạo fulfillment mới.
        const late = await provider(code, "picking");
        expect(late).toMatchObject({ state: "unfulfilled", ignored: "out_of_order" });
        const again = await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("order_staff"));
        expect(again.status).toBe(409);
        expect(ghn.createCalls).toBe(1);
        await ensureNativeFulfillment(container, (await shipping().shipmentOfOrder(o.orderId))!, {
          actor_type: "system",
          actor_id: null,
          request_id: null,
          ip_hash: null,
        });
        expect((await fulfillments(o.orderId)).list).toHaveLength(1);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });

        // Khách không thấy yêu cầu nội bộ của kho.
        const mine = await flow.storeReturns(o);
        expect(mine.status).toBe(200);
        expect(mine.data.returns).toEqual([]);

        // Kiểm định: support bị từ chối, kho được phép; đạt → về kho bán, không mở hoàn tiền.
        const [ret] = await carrierReturns(o.orderId);
        const line = await lineOf(o.orderId, "Đen/M");
        const pass = [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }];
        expect((await inspect(ret!.id, "support", pass)).status).toBe(403);
        expect(await quarantine("Đen/M")).toBe(1);
        const ok = await inspect(ret!.id, "warehouse", pass);
        expect(ok.status).toBe(200);
        expect(ok.data).toMatchObject({ refund: null, return: { state: "closed", source: "carrier" } });
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 10, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(0);
        expect((await money(o.orderId)).refunds).toEqual([]);
      });

      it("VNPAY: đơn hủy + yêu cầu hoàn toàn bộ chờ duyệt (không tự hoàn); đơn native chờ hoàn tiền mới hủy", async () => {
        const o = await flow.place([["Trắng/S", 2]], "vnpay");
        const code = await createShipment(o);
        const c = await provider(code, "cancel");
        expect(c.carrier).toMatchObject({ outcome: "cancelled", order_cancelled: true, paid: o.total });
        const m = await money(o.orderId);
        expect(m.ledger).toEqual([{ kind: "capture", amount: o.total }]);
        expect(m.refunds).toEqual([
          expect.objectContaining({
            reason: "cancellation",
            amount: o.total,
            method: "provider",
            state: "requested",
            requested_by: "system:carrier",
          }),
        ]);
        expect(m.refundRequests).toEqual([expect.objectContaining({ state: "open", amount: o.total })]);
        expect(await quarantine("Trắng/S")).toBe(2);
        expect(await levelAt("Trắng/S", fx.sellableLocationId)).toEqual({ stocked: 8, reserved: 0 });
        const native = await fulfillments(o.orderId);
        expect(native.list[0]!.canceled_at).not.toBeNull();
        expect(native.status).not.toBe("canceled");
        expect(await view(o)).toMatchObject({ state: "cancelled", payment_state: "refund_pending" });
      });

      it("hãng báo cancel khi đã lấy hàng → bỏ qua (không lùi), đơn giữ nguyên", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        const code = await createShipment(o);
        expect((await provider(code, "delivering")).state).toBe("shipped");
        const c = await provider(code, "cancel");
        expect(c).toMatchObject({ state: "shipped", ignored: "out_of_order" });
        expect(c.carrier).toBeUndefined();
        expect(await finState(o.orderId)).toBe("confirmed");
        expect(await carrierReturns(o.orderId)).toHaveLength(0);
        expect(await quarantine("Đen/M")).toBe(0);
      });
    });

    /* ------------------------------------------------------------------ hoàn về người gửi */

    describe("hoàn về người gửi", () => {
      it("VNPAY 2 kho: đang hoàn chưa đụng đơn; đã hoàn → cách ly + hoàn tiền chờ duyệt; kiểm định đạt → đúng kho đã xuất, lỗi → ở lại cách ly", async () => {
        const kho2 = await secondWarehouse({ "Trắng/S": 5 });
        await updateInventoryLevelsWorkflow(container).run({
          input: {
            updates: [
              {
                inventory_item_id: fx.variants["Trắng/S"]!.inventoryItemId,
                location_id: fx.sellableLocationId,
                stocked_quantity: 0,
              },
            ],
          },
        });
        const o = await flow.place(
          [
            ["Đen/M", 1],
            ["Trắng/S", 2],
          ],
          "vnpay",
        );
        const code = await createShipment(o);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        expect(await levelAt("Trắng/S", kho2)).toEqual({ stocked: 3, reserved: 0 });

        for (const st of [
          "delivering",
          "delivery_fail",
          "waiting_to_return",
          "return",
          "return_transporting",
        ]) {
          const r = await provider(code, st);
          expect(r.carrier).toBeUndefined();
        }
        expect((await shipping().shipmentOfOrder(o.orderId))!.state).toBe("returning");
        expect(await finState(o.orderId)).toBe("confirmed");
        expect(await carrierReturns(o.orderId)).toHaveLength(0);

        const done = await provider(code, "returned");
        expect(done).toMatchObject({
          state: "returned",
          native_sync: "ok",
          carrier: { outcome: "returned", order_cancelled: true, paid: o.total, return_state: "received" },
        });
        expect(await finState(o.orderId)).toBe("cancelled");
        // Tồn bán không đổi; hàng nằm ở cách ly.
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        expect(await levelAt("Trắng/S", kho2)).toEqual({ stocked: 3, reserved: 0 });
        expect(await levelAt("Trắng/S", fx.sellableLocationId)).toEqual({ stocked: 0, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(1);
        expect(await quarantine("Trắng/S")).toBe(2);
        // Tiền: đã thu → một yêu cầu hoàn toàn bộ chờ duyệt, chưa có bút toán hoàn.
        const m = await money(o.orderId);
        expect(m.ledger).toEqual([{ kind: "capture", amount: o.total }]);
        expect(m.refunds).toEqual([
          expect.objectContaining({ reason: "cancellation", amount: o.total, state: "requested" }),
        ]);
        expect(m.refundRequests).toHaveLength(1);
        // Fulfillment đã giao cho hãng giữ nguyên làm lịch sử.
        const native = await fulfillments(o.orderId);
        expect(native.list).toHaveLength(1);
        expect(native.list[0]).toMatchObject({ canceled_at: null });
        expect(native.list[0]!.shipped_at).not.toBeNull();

        const [ret] = await carrierReturns(o.orderId);
        const den = await lineOf(o.orderId, "Đen/M");
        const trang = await lineOf(o.orderId, "Trắng/S");
        const r = await inspect(ret!.id, "warehouse", [
          { line_id: den, restock_quantity: 1, damaged_quantity: 0 },
          { line_id: trang, restock_quantity: 1, damaged_quantity: 1, note: "Rách đường may" },
        ]);
        expect(r.status).toBe(200);
        expect(r.data).toMatchObject({ refund: null, return: { state: "closed" } });
        // Đạt → về ĐÚNG kho đã xuất của từng SKU (Đen/M: Kho chính; Trắng/S: kho phụ — không phải kho mặc định).
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 10, reserved: 0 });
        expect(await levelAt("Trắng/S", kho2)).toEqual({ stocked: 4, reserved: 0 });
        expect(await levelAt("Trắng/S", fx.sellableLocationId)).toEqual({ stocked: 0, reserved: 0 });
        // Lỗi → ở lại cách ly, không vào tồn bán.
        expect(await quarantine("Đen/M")).toBe(0);
        expect(await quarantine("Trắng/S")).toBe(1);
        // Kiểm định hàng hoàn không mở thêm hoàn tiền.
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(1);
        // Gửi lại cùng kết quả → idempotent.
        const again = await inspect(ret!.id, "warehouse", [
          { line_id: den, restock_quantity: 1, damaged_quantity: 0 },
          { line_id: trang, restock_quantity: 1, damaged_quantity: 1 },
        ]);
        expect(again.data.changed).toBe(false);
        expect(await levelAt("Trắng/S", kho2)).toEqual({ stocked: 4, reserved: 0 });
      });

      it("COD hoàn về chưa thu: đơn hủy, không ghi thu/không hoàn; hàng lỗi ở lại cách ly", async () => {
        const before = await shipping().codReceivable();
        const o = await flow.place([["Đen/M", 1]], "cod");
        const code = await createShipment(o);
        await provider(code, "delivering");
        await provider(code, "delivery_fail");
        const r = await provider(code, "returned");
        expect(r.carrier).toMatchObject({
          outcome: "returned",
          order_cancelled: true,
          paid: 0,
          refund_id: null,
        });
        expect(await finState(o.orderId)).toBe("cancelled");
        expect(await money(o.orderId)).toEqual({ ledger: [], refunds: [], refundRequests: [] });
        expect(await view(o)).toMatchObject({ state: "cancelled", payment_state: "void" });
        expect(await shipping().codReceivable()).toEqual(before);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(1);

        const [ret] = await carrierReturns(o.orderId);
        const line = await lineOf(o.orderId, "Đen/M");
        const res = await inspect(ret!.id, "warehouse", [
          { line_id: line, restock_quantity: 0, damaged_quantity: 1 },
        ]);
        expect(res.status).toBe(200);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        expect(await quarantine("Đen/M")).toBe(1);
        expect((await money(o.orderId)).refunds).toEqual([]);
      });

      it("callback lặp + đồng thời → một yêu cầu hàng hoàn, cách ly cộng một lần, một hoàn tiền, đơn hủy một lần", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const code = await createShipment(o);
        await provider(code, "return");
        ghn.setStatusByOrderCode(code, "returned");
        const t1 = nextTime();
        const rs = await Promise.all([
          callback(code, "returned", t1),
          callback(code, "returned", t1),
          callback(code, "returned", nextTime()),
          callback(code, "returned", nextTime()),
        ]);
        expect(rs.some((x) => x.status === 200)).toBe(true);
        // Nhánh nào chưa xử lý xong (503) thì hãng gửi lại — vẫn chỉ một lần.
        expect((await callback(code, "returned")).status).toBe(200);
        expect(await carrierReturns(o.orderId)).toHaveLength(1);
        expect(await quarantine("Đen/M")).toBe(1);
        expect(await levelAt("Đen/M", fx.sellableLocationId)).toEqual({ stocked: 9, reserved: 0 });
        const m = await money(o.orderId);
        expect(m.refunds).toHaveLength(1);
        expect(m.refundRequests).toHaveLength(1);
        const cancelled = await checkout().listOutboxEvents({
          aggregate_id: o.orderId,
          type: "order.cancelled",
        });
        expect(cancelled).toHaveLength(1);
        const audits = (
          await container
            .resolve(ContainerRegistrationKeys.PG_CONNECTION)
            .raw(`SELECT action FROM audit_log WHERE resource_id = ? AND action = 'order.cancelled'`, [
              o.orderId,
            ])
        ).rows as unknown[];
        expect(audits).toHaveLength(1);
      });
    });

    /* ------------------------------------------------------------------ không lùi */

    describe("đã giao không lùi", () => {
      it("sau delivered: returned/return/cancel/delivery_fail → bỏ qua; đơn không hủy, không hàng hoàn, không hoàn tiền", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        await flow.deliver(o);
        const code = (await shipping().shipmentOfOrder(o.orderId))!.provider_order_code as string;
        for (const st of ["returned", "return", "cancel", "delivery_fail", "waiting_to_return"]) {
          const r = await provider(code, st);
          expect(r).toMatchObject({ state: "delivered", ignored: "out_of_order" });
          expect(r.carrier).toBeUndefined();
        }
        expect((await shipping().shipmentOfOrder(o.orderId))!.state).toBe("delivered");
        expect(await finState(o.orderId)).toBe("confirmed");
        expect(await carrierReturns(o.orderId)).toHaveLength(0);
        expect(await quarantine("Đen/M")).toBe(0);
        expect((await money(o.orderId)).refunds).toEqual([]);
        expect((await view(o)).shipment_state).toBe("delivered");
      });
    });
  },
});
