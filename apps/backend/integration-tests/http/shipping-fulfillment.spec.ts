import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { ensureNativeFulfillment } from "../../src/lib/shipping/fulfillment";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { adminHeaders, type HttpClient } from "../helpers/auth";
import { DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import { inventoryLevel, seedCatalog, setStock, type CatalogFixture } from "../helpers/checkout-fixtures";
import { newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-043 — vận đơn GHN ⇒ fulfillment native: reservation được nhả, stocked trừ ĐÚNG MỘT LẦN (gọi lại, timeout, đồng thời),
 * trạng thái giao hãng ánh xạ sang fulfillment (shipped/delivered), hàng hoàn KHÔNG tự restock; view đơn trả
 * shipment_state/can_cancel đúng. Đơn COD và VNPAY đi luồng HTTP thật (mock cổng/hãng).
 */
interface NativeFul {
  id: string;
  location_id: string;
  packed_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  canceled_at: string | null;
  metadata: Record<string, unknown> | null;
  items: Array<{ line_item_id: string; inventory_item_id: string | null; quantity: unknown }>;
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let ghn: MockModeGhnClient;
    let staff: { userId: string; headers: Record<string, string> };
    let ip = newIp();
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.headers,
      ip: () => ip,
    });
    const shipping = () => container.resolve<ShippingModuleService>(SHIPPING_MODULE);

    beforeAll(() => setVnpayGatewayForTest(gateway));
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container);
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      ip = newIp();
      staff = await adminHeaders(api as unknown as HttpClient, container, { roles: ["order_staff"] });
    });

    const createShipment = (o: PlacedOrder, headers = staff.headers): Promise<Res<J>> =>
      api.post(
        `/admin/x/orders/${o.orderId}/shipments`,
        {},
        { headers, validateStatus: () => true },
      ) as never;
    const view = async (o: PlacedOrder): Promise<J> => {
      const r = (await api.get(
        `/store/x/orders/${o.ref}`,
        flow.client.cfg({ "x-forwarded-for": ip, "x-order-access": o.access }),
      )) as Res<J>;
      expect(r.status).toBe(200);
      return r.data;
    };
    const callback = (code: string, status: string, time: string): Promise<Res<J>> =>
      api.post(
        "/x/webhooks/shipping/ghn",
        { OrderCode: code, Type: "Switch_status", Status: status, Time: time, CODAmount: 0 },
        { validateStatus: () => true },
      ) as never;
    const fulfillments = async (orderId: string): Promise<NativeFul[]> => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: [
          "id",
          "fulfillments.id",
          "fulfillments.location_id",
          "fulfillments.packed_at",
          "fulfillments.shipped_at",
          "fulfillments.delivered_at",
          "fulfillments.canceled_at",
          "fulfillments.metadata",
          "fulfillments.items.line_item_id",
          "fulfillments.items.inventory_item_id",
          "fulfillments.items.quantity",
        ],
        filters: { id: orderId },
      });
      return ((data[0] as { fulfillments?: NativeFul[] } | undefined)?.fulfillments ?? []).filter(Boolean);
    };
    const reservationsOfOrder = async (orderId: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "items.id"],
        filters: { id: orderId },
      });
      const ids = ((data[0] as { items?: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      return container.resolve(Modules.INVENTORY).listReservationItems({ line_item_id: ids });
    };
    const fulfillmentLedger = async (key: string) =>
      (
        await container.resolve(ContainerRegistrationKeys.PG_CONNECTION).raw(
          `SELECT delta, stocked_before, stocked_after FROM inventory_adjustment WHERE reason = 'fulfillment'
              AND inventory_item_id = ? ORDER BY created_at`,
          [fx.variants[key]!.inventoryItemId],
        )
      ).rows as Array<{
        delta: number;
        stocked_before: number;
        stocked_after: number;
      }>;

    describe("VNPAY — tạo vận đơn ⇒ fulfillment native, nhả reservation, trừ tồn một lần", () => {
      it("trước/sau: reserved 1→0, stocked 10→9; gọi lại → 200 không trừ lần 2; view packed, can_cancel=false, hủy → 409", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 1 });
        const before = await view(o);
        expect(before).toMatchObject({ state: "confirmed", shipment_state: "unfulfilled" });
        expect(before.actions.can_cancel).toBe(true);

        const r = await createShipment(o);
        expect(r.status).toBe(201);
        const shipmentId = r.data.shipment.id as string;
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect(await reservationsOfOrder(o.orderId)).toHaveLength(0);
        const fs = await fulfillments(o.orderId);
        expect(fs).toHaveLength(1);
        expect(fs[0]).toMatchObject({
          location_id: fx.sellableLocationId,
          shipped_at: null,
          delivered_at: null,
          canceled_at: null,
        });
        expect(fs[0]!.packed_at).not.toBeNull();
        expect(fs[0]!.metadata).toMatchObject({
          x_shipment_id: shipmentId,
          x_provider: "ghn",
          x_provider_order_code: r.data.shipment.provider_order_code,
        });
        expect(fs[0]!.items).toEqual([
          expect.objectContaining({ inventory_item_id: fx.variants["Đen/M"]!.inventoryItemId }),
        ]);
        expect(await fulfillmentLedger("Đen/M")).toEqual([
          expect.objectContaining({ delta: -1, stocked_before: 10, stocked_after: 9 }),
        ]);

        const v = await view(o);
        expect(v.shipment_state).toBe("packed");
        expect(v.actions.can_cancel).toBe(false);
        const c = await flow.cancel(o);
        expect(c.status).toBe(409);
        expect(c.data.code).toBe("NOT_CANCELLABLE");

        const again = await createShipment(o);
        expect(again.status).toBe(200);
        expect(again.data.shipment.id).toBe(shipmentId);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect(await fulfillments(o.orderId)).toHaveLength(1);
        expect(await fulfillmentLedger("Đen/M")).toHaveLength(1);
        expect(ghn.createCalls).toBe(1);

        // Gọi trực tiếp lần nữa (vd sập sau khi tạo fulfillment) → chỉ replay sổ, không trừ thêm.
        const row = (await shipping().shipmentOfOrder(o.orderId))!;
        await ensureNativeFulfillment(container, row, {
          actor_type: "system",
          actor_id: null,
          request_id: null,
          ip_hash: null,
        });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect(await fulfillments(o.orderId)).toHaveLength(1);
      });
    });

    describe("COD — nhiều dòng", () => {
      it("Đen/M ×1 + Trắng/S ×2: mỗi SKU trừ đúng số giao, reserved về 0", async () => {
        const o = await flow.place(
          [
            ["Đen/M", 1],
            ["Trắng/S", 2],
          ],
          "cod",
        );
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 10, reserved: 2 });
        const r = await createShipment(o);
        expect(r.status).toBe(201);
        expect(r.data.shipment.cod_amount).toBe(o.total);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 8, reserved: 0 });
        const fs = await fulfillments(o.orderId);
        expect(fs).toHaveLength(1);
        expect(fs[0]!.items).toHaveLength(2);
        const v = await view(o);
        expect(v).toMatchObject({ payment_state: "cod", shipment_state: "packed" });
        expect(v.actions.can_cancel).toBe(false);
      });
    });

    describe("timeout khi tạo vận đơn — không trừ khi chưa rõ, không trừ hai lần khi rõ", () => {
      it("timeout + tra cứu sập → 202: tồn/giữ không đổi, chưa có fulfillment, can_cancel=false; gọi lại → 201 trừ một lần", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        ghn.createFaults.push("timeout_after_commit");
        ghn.detailFailures = 1;
        const r1 = await createShipment(o);
        expect(r1.status).toBe(202);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 1 });
        expect(await fulfillments(o.orderId)).toHaveLength(0);
        const v = await view(o);
        expect(v.shipment_state).toBe("unfulfilled");
        expect(v.actions.can_cancel).toBe(false);

        const r2 = await createShipment(o);
        expect(r2.status).toBe(201);
        const r3 = await createShipment(o);
        expect(r3.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect(await fulfillments(o.orderId)).toHaveLength(1);
        expect(await fulfillmentLedger("Đen/M")).toHaveLength(1);
        expect(ghn.mock.created).toBe(1);
      });

      it("timeout trước khi hãng ghi (COD) → 202; gọi lại gửi lại cùng mã → 1 vận đơn, 1 fulfillment, trừ một lần", async () => {
        const o = await flow.place([["Trắng/S", 2]], "cod");
        ghn.createFaults.push("timeout_before_commit");
        expect((await createShipment(o)).status).toBe(202);
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 10, reserved: 2 });
        expect((await createShipment(o)).status).toBe(201);
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 8, reserved: 0 });
        expect(await fulfillments(o.orderId)).toHaveLength(1);
        expect(ghn.mock.created).toBe(1);
      });
    });

    describe("đồng thời", () => {
      it("2 nhân viên cùng tạo vận đơn cùng đơn → 1 shipment, 1 fulfillment, stocked trừ một lần", async () => {
        const o = await flow.place([["Đen/M", 2]], "cod");
        const other = await adminHeaders(api as unknown as HttpClient, container, { roles: ["order_staff"] });
        ghn.createDelayMs = 300;
        const [a, b] = await Promise.all([createShipment(o), createShipment(o, other.headers)]);
        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(await shipping().listShipments({ order_id: o.orderId })).toHaveLength(1);
        expect(await fulfillments(o.orderId)).toHaveLength(1);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 8, reserved: 0 });
        expect(await fulfillmentLedger("Đen/M")).toHaveLength(1);
      });

      it("5 lần gọi lại song song sau khi đã có vận đơn → vẫn 1 fulfillment, không trừ thêm", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        expect((await createShipment(o)).status).toBe(201);
        const rs = await Promise.all(Array.from({ length: 5 }, () => createShipment(o)));
        expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
        expect(rs.some((r) => r.status === 200)).toBe(true);
        expect(await fulfillments(o.orderId)).toHaveLength(1);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
      });

      it("đơn khác đặt song song với lúc xuất kho không bị bán âm (tồn sát: stocked = reserved)", async () => {
        const o = await flow.place([["Đen/S", 1]], "vnpay");
        await setStock(container, fx, "Đen/S", 1);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 1, reserved: 1 });
        const [r, late] = await Promise.all([
          createShipment(o),
          flow.place([["Đen/S", 1]], "cod").then(
            () => "placed",
            (e: Error) => e.message,
          ),
        ]);
        expect(r.status).toBe(201);
        // Bị chặn ở giỏ (Medusa) hoặc ở submit (409 INSUFFICIENT_STOCK) — miễn là không đặt được.
        expect(late).toMatch(/409|INSUFFICIENT_STOCK|insufficient_inventory/);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 0, reserved: 0 });
      });
    });

    describe("trạng thái hãng ⇒ fulfillment native", () => {
      it("đang giao → shipped_at; đã giao → delivered_at; lặp không đổi tồn; view shipped → delivered + timeline", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        const s = (await createShipment(o)).data.shipment;
        const code = s.provider_order_code as string;
        ghn.setStatusByOrderCode(code, "delivering");
        const c1 = await callback(code, "delivering", "2026-10-25T03:00:00Z");
        expect(c1.data).toMatchObject({ ok: true, state: "shipped", native_sync: "ok" });
        let fs = await fulfillments(o.orderId);
        expect(fs[0]!.shipped_at).not.toBeNull();
        expect(fs[0]!.delivered_at).toBeNull();
        expect((await view(o)).shipment_state).toBe("shipped");

        ghn.setStatusByOrderCode(code, "delivered");
        expect((await callback(code, "delivered", "2026-10-25T05:00:00Z")).data).toMatchObject({
          state: "delivered",
          native_sync: "ok",
        });
        expect((await callback(code, "delivered", "2026-10-25T05:00:01Z")).data).toMatchObject({
          state: "delivered",
          native_sync: "ok",
        });
        fs = await fulfillments(o.orderId);
        expect(fs).toHaveLength(1);
        expect(fs[0]!.delivered_at).not.toBeNull();
        const v = await view(o);
        expect(v.shipment_state).toBe("delivered");
        expect(v.actions.can_cancel).toBe(false);
        expect((v.timeline as Array<{ kind: string }>).map((t) => t.kind)).toEqual(
          expect.arrayContaining(["shipped", "delivered"]),
        );
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
      });

      it("giao lỗi rồi hoàn về: fulfillment không hủy, tồn bán KHÔNG tự cộng lại (hàng hoàn qua kiểm định)", async () => {
        const o = await flow.place([["Trắng/M", 1]], "vnpay");
        const code = (await createShipment(o)).data.shipment.provider_order_code as string;
        for (const [st, t] of [
          ["delivering", "2026-10-25T03:00:00Z"],
          ["delivery_fail", "2026-10-25T04:00:00Z"],
          ["return", "2026-10-25T05:00:00Z"],
          ["returned", "2026-10-25T09:00:00Z"],
        ] as const) {
          ghn.setStatusByOrderCode(code, st);
          expect((await callback(code, st, t)).status).toBe(200);
        }
        const row = (await shipping().shipmentOfOrder(o.orderId))!;
        expect(row.state).toBe("returned");
        const fs = await fulfillments(o.orderId);
        expect(fs).toHaveLength(1);
        expect(fs[0]).toMatchObject({ canceled_at: null, delivered_at: null });
        expect(fs[0]!.shipped_at).not.toBeNull();
        expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 9, reserved: 0 });
        expect((await view(o)).actions.can_cancel).toBe(false);
      });

      it("vận đơn có từ trước T-043 (không có fulfillment): view theo vận đơn; callback đã giao → tự tạo fulfillment, trừ một lần", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const svc = shipping();
        const { shipment } = await svc.reserveShipment({
          order_id: o.orderId,
          client_order_code: `${o.ref}-S1`,
          provider: "ghn",
          cod_amount: 0,
          payer: "shop",
          created_by: staff.userId,
        });
        const created = await ghn.createOrder({
          clientOrderCode: `${o.ref}-S1`,
          to: {
            name: "Nguyễn Văn An",
            phone: "0912345678",
            address: {
              provinceCode: "01",
              provinceName: "Thành phố Hà Nội",
              wardCode: "00004",
              wardName: "Phường Ba Đình",
              line: "12 Phố Điện Biên Phủ",
              original: null,
              datasetVersion: "test",
            },
          },
          codAmount: 0,
          insuranceValue: 0,
          weightGrams: 500,
          items: [{ name: "Áo", code: "SKU", quantity: 1, price: 700_000, weightGrams: 500 }],
          paymentTypeId: 1,
          requiredNote: "CHOXEMHANGKHONGTHU",
        });
        await svc.markCreated(shipment.id, created.orderCode, null, "packed");
        expect(await fulfillments(o.orderId)).toHaveLength(0);
        const v = await view(o);
        expect(v.shipment_state).toBe("packed");
        expect(v.actions.can_cancel).toBe(false);

        ghn.setStatusByOrderCode(created.orderCode, "delivered");
        const cb = await callback(created.orderCode, "delivered", "2026-10-25T05:00:00Z");
        expect(cb.data).toMatchObject({ state: "delivered", native_sync: "ok" });
        const fs = await fulfillments(o.orderId);
        expect(fs).toHaveLength(1);
        expect(fs[0]!.shipped_at).not.toBeNull();
        expect(fs[0]!.delivered_at).not.toBeNull();
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 9, reserved: 0 });
        expect((await view(o)).shipment_state).toBe("delivered");
      });
    });

    describe("dữ liệu lệch và phân quyền", () => {
      it("mất reservation trước khi tạo vận đơn → 409 FULFILLMENT_BLOCKED, không trừ mù; vận đơn giữ, gọi lại không gửi hãng lần 2", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const rs = await reservationsOfOrder(o.orderId);
        await container.resolve(Modules.INVENTORY).deleteReservationItems(rs.map((r) => r.id));
        const r = await createShipment(o);
        expect(r.status).toBe(409);
        expect(r.data).toMatchObject({ code: "FULFILLMENT_BLOCKED", reason: "NO_RESERVATION" });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });
        expect(await fulfillments(o.orderId)).toHaveLength(0);
        expect((await shipping().shipmentOfOrder(o.orderId))!.provider_order_code).toMatch(/^GHNMOCK/);
        expect((await createShipment(o)).status).toBe(409);
        expect(ghn.createCalls).toBe(1);
        expect((await view(o)).actions.can_cancel).toBe(false);
      });

      it("vai trò không có fulfillment.create (support) → 403: không vận đơn, không fulfillment, tồn giữ nguyên", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const support = await adminHeaders(api as unknown as HttpClient, container, { roles: ["support"] });
        const r = await createShipment(o, support.headers);
        expect(r.status).toBe(403);
        expect(await shipping().listShipments({ order_id: o.orderId })).toHaveLength(0);
        expect(await fulfillments(o.orderId)).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 1 });
        expect(ghn.createCalls).toBe(0);
      });
    });
  },
});
