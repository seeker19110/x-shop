import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-147 review 2 — route GHI native trả về đơn/vận đơn: handler của Medusa tải lại thực thể theo `req.queryConfig.fields`
 * (mặc định của đơn gồm `email`, `*customer`, `*shipping_address`). Kho (`fulfillment.update`, không `order.read`) gọi
 * được các route vận đơn native → phản hồi chỉ được có trường tối thiểu (field-policy.ts: ORDER_MIN_FIELDS /
 * FULFILLMENT_MIN_FIELDS), kể cả khi KHÔNG gửi `fields`. Đơn thật: submit COD → xác nhận → tạo vận đơn GHN (mock).
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"owner" | "order_staff" | "warehouse", MfaAdmin>;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["owner", "order_staff", "warehouse"] as const)
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, { stock: { "Đen/S": 20 } });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      ip = newIp();
    });

    /** Đơn COD đã xác nhận + có vận đơn native; trả PII thật của đơn để dò trong phản hồi. */
    async function shippedOrder(): Promise<{ o: PlacedOrder; fulfillmentId: string; pii: string[] }> {
      const o = await flow.place([["Đen/S", 1]], "cod");
      const created = await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, staff.order_staff.headers);
      if (created.status !== 201) throw new Error(`tạo vận đơn lỗi ${created.status}`);
      const query = container.resolve(ContainerRegistrationKeys.QUERY);
      const {
        data: [order],
      } = await query.graph({
        entity: "order",
        fields: ["email", "shipping_address.phone", "shipping_address.address_1", "fulfillments.id"],
        filters: { id: o.orderId },
      });
      const row = order as unknown as {
        email: string;
        shipping_address: { phone: string; address_1: string };
        fulfillments: { id: string }[];
      };
      const pii = [row.email, row.shipping_address?.phone, row.shipping_address?.address_1].filter(
        (v): v is string => typeof v === "string" && v.length >= 6,
      );
      // Email đơn có thể rỗng (liên hệ lưu ở order_finance); SĐT + địa chỉ giao luôn có trên đơn native.
      expect(pii.length).toBeGreaterThanOrEqual(2);
      return { o, fulfillmentId: row.fulfillments[0]!.id, pii };
    }

    const leaked = (data: unknown, pii: string[]) =>
      pii.filter((v) => JSON.stringify(data ?? "").includes(v));

    it("kho POST vận đơn native KHÔNG gửi fields → phản hồi chỉ trường tối thiểu, không email/SĐT/địa chỉ", async () => {
      const { o, fulfillmentId, pii } = await shippedOrder();
      const shipment = await flow.admin(
        `/admin/fulfillments/${fulfillmentId}/shipment`,
        staff.warehouse.headers,
        {
          labels: [
            {
              tracking_number: "T147",
              tracking_url: "https://ghn.test/t147",
              label_url: "https://ghn.test/l",
            },
          ],
        },
      );
      expect(shipment.status).toBeLessThan(500);
      expect(leaked(shipment.data, pii)).toEqual([]);
      if (shipment.status === 200) {
        const f = shipment.data.fulfillment as J;
        expect(f.id).toBe(fulfillmentId);
        for (const key of ["delivery_address", "data", "order", "metadata"])
          expect({ key, present: key in f }).toEqual({ key, present: false });
      }

      const delivered = await flow.admin(
        `/admin/orders/${o.orderId}/fulfillments/${fulfillmentId}/mark-as-delivered`,
        staff.warehouse.headers,
      );
      expect(delivered.status).toBe(200);
      expect(leaked(delivered.data, pii)).toEqual([]);
      const order = delivered.data.order as J;
      expect(order.id).toBe(o.orderId);
      for (const key of ["email", "customer", "shipping_address", "billing_address", "items", "total"])
        expect({ key, present: key in order }).toEqual({ key, present: false });
    });

    it("kho POST vận đơn native kèm `?fields=` tới PII → 403, không ghi", async () => {
      const { o, fulfillmentId, pii } = await shippedOrder();
      for (const url of [
        `/admin/orders/${o.orderId}/fulfillments/${fulfillmentId}/mark-as-delivered?fields=id,email,*shipping_address`,
        `/admin/orders/${o.orderId}/fulfillments/${fulfillmentId}/mark-as-delivered?fields=+customer.phone`,
        `/admin/fulfillments/${fulfillmentId}/shipment?fields=id,*delivery_address,order.email`,
      ]) {
        const res = await flow.admin(url, staff.warehouse.headers, { labels: [] });
        expect({ url, status: res.status, leak: leaked(res.data, pii) }).toEqual({
          url,
          status: 403,
          leak: [],
        });
      }
      const query = container.resolve(ContainerRegistrationKeys.QUERY);
      const {
        data: [f],
      } = await query.graph({
        entity: "fulfillment",
        fields: ["delivered_at"],
        filters: { id: fulfillmentId },
      });
      expect((f as { delivered_at: Date | null }).delivered_at).toBeNull();
    });

    it("owner (order.read) gọi cùng route vẫn nhận đơn đầy đủ như trước", async () => {
      const { o, fulfillmentId, pii } = await shippedOrder();
      const res = await flow.admin(
        `/admin/orders/${o.orderId}/fulfillments/${fulfillmentId}/mark-as-delivered?fields=id,email,*shipping_address`,
        staff.owner.headers,
      );
      expect(res.status).toBe(200);
      expect(leaked(res.data, pii)).toEqual(pii);
    });
  },
});
