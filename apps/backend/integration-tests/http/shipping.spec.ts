import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { listWards } from "@x-shop/domain";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { getGhnClient, MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { adminHeaders, type HttpClient } from "../helpers/auth";
import { checkoutClient, DEV_VNPAY, ipn, type Api, type Res } from "../helpers/checkout-api";
import { HANOI_ADDRESS, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

interface ShipmentView {
  id: string;
  order_id: string;
  client_order_code: string;
  provider_order_code: string | null;
  state: string;
  cod_amount: number;
  payer: string;
  created_by: string;
  settlement_state: string;
  cod_reported_amount: number | null;
  delivered_at: string | null;
  label_url?: unknown;
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let ghn: MockModeGhnClient;
    let staff: { userId: string; headers: Record<string, string> };
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const client = checkoutClient(api, () => fx);
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
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
      clearShippingFeeCache();
      staff = await adminHeaders(api as unknown as HttpClient, container);
    });

    const adminCfg = (headers: Record<string, string>) => ({ headers, validateStatus: () => true });
    const createShipment = (
      orderId: string,
      headers = staff.headers,
    ): Promise<Res<Record<string, unknown>>> =>
      api.post(`/admin/x/orders/${orderId}/shipments`, {}, adminCfg(headers)) as never;
    const confirmCod = (orderId: string, headers = staff.headers): Promise<Res<Record<string, unknown>>> =>
      api.post(`/admin/x/orders/${orderId}/confirm-cod`, {}, adminCfg(headers)) as never;
    const callback = (body: Record<string, unknown>): Promise<Res<Record<string, unknown>>> =>
      api.post("/x/webhooks/shipping/ghn", body, { validateStatus: () => true }) as never;
    const shipmentOf = (r: Res<Record<string, unknown>>) => r.data.shipment as ShipmentView;
    const finance = async (orderId: string) =>
      (await checkout().listOrderFinances({ order_id: orderId }))[0]!;

    async function paidVnpayOrder() {
      const o = await client.placeOrder([["Đen/M", 1]], "vnpay");
      const params = gateway.mock.pay(o.paymentUrl, "success");
      expect((await ipn(api, params)).data.RspCode).toBe("00");
      return o;
    }

    async function confirmedCodOrder() {
      const o = await client.placeOrder(
        [
          ["Đen/M", 1],
          ["Trắng/S", 2],
        ],
        "cod",
      );
      expect((await confirmCod(o.orderId)).status).toBe(200);
      return o;
    }

    it("dùng GHN giả lập (GHN_MODE=mock mặc định ở test)", () => {
      expect(getGhnClient()).toBe(ghn);
    });

    describe("báo phí GHN trong quote", () => {
      it("quote có phí từ hãng + thời điểm/hạn báo phí; phường hãng không phục vụ → 422 ADDRESS_NOT_SERVED", async () => {
        const cartId = await client.createCart([["Đen/M", 1]]);
        const q = (await client.quote(cartId)) as unknown as {
          shipping_fee: number;
          shipping_quote: { provider: string; quoted_at: string; expires_at: string };
        };
        expect(q.shipping_fee).toBe(30_000);
        expect(q.shipping_quote.provider).toBe("ghn");
        expect(Date.parse(q.shipping_quote.expires_at) - Date.parse(q.shipping_quote.quoted_at)).toBe(
          10 * 60_000,
        );

        const other = listWards("01").find((w) => w.code !== HANOI_ADDRESS.ward_code)!;
        ghn.unservedWards.add(other.code);
        const res = await api.post(
          "/store/x/checkout/quote",
          {
            cart_id: cartId,
            payment_method: "cod",
            address: { ...HANOI_ADDRESS, ward_code: other.code },
          },
          client.cfg(),
        );
        expect(res.status).toBe(422);
        expect(res.data).toMatchObject({
          code: "ADDRESS_NOT_SERVED",
          field: "address",
          action: "change_address",
        });
      });
    });

    describe("AT34 — chưa xác nhận/chưa finalization → không tạo vận đơn", () => {
      it("COD chưa xác nhận, online chưa thu, order_finance còn preparing → 409; hãng không bị gọi", async () => {
        const cod = await client.placeOrder([["Đen/S", 1]], "cod");
        const r1 = await createShipment(cod.orderId);
        expect(r1.status).toBe(409);
        expect(r1.data).toMatchObject({
          code: "ORDER_NOT_READY",
          order_state: "placed",
          payment_method: "cod",
        });

        const online = await client.placeOrder([["Đen/S", 1]], "vnpay");
        expect((await createShipment(online.orderId)).data).toMatchObject({
          code: "ORDER_NOT_READY",
          order_state: "awaiting_payment",
        });
        // Đơn native đã có nhưng checkout chưa finalization (preparing).
        await checkout().insertOrderFinance({
          order_id: "order_chua_finalize",
          display_ref: "XS-PREP01",
          checkout_attempt_id: "chk_x",
          cart_id: "cart_x",
          total: 100_000,
          payment_method: "cod",
          policy_version: "test",
          quote: {},
          address: {},
          contact: {},
        });
        expect((await createShipment("order_chua_finalize")).data).toMatchObject({
          code: "ORDER_NOT_READY",
          order_state: "preparing",
        });
        expect((await confirmCod("order_chua_finalize")).status).toBe(409);
        expect((await createShipment("order_khong_co")).status).toBe(404);
        expect(ghn.createCalls).toBe(0);
        expect(await shipping().listShipments({})).toHaveLength(0);
      });

      it("quyền: không đăng nhập quản trị → 401 ở cả tạo vận đơn và xác nhận COD", async () => {
        const cod = await client.placeOrder([["Đen/S", 1]], "cod");
        expect((await createShipment(cod.orderId, {})).status).toBe(401);
        expect((await confirmCod(cod.orderId, {})).status).toBe(401);
        expect((await finance(cod.orderId)).state).toBe("placed");
      });
    });

    describe("AT13 + AT23 — online đã trả đủ: COD 0, địa chỉ 2 cấp", () => {
      it("tạo vận đơn mock với is_new_to_address, không quận/huyện, cod_amount 0, shop trả phí; gọi lại → 200 cùng vận đơn", async () => {
        const o = await paidVnpayOrder();
        expect((await finance(o.orderId)).state).toBe("confirmed");
        const r = await createShipment(o.orderId);
        expect(r.status).toBe(201);
        const s = shipmentOf(r);
        expect(s).toMatchObject({ state: "packed", cod_amount: 0, payer: "shop", created_by: staff.userId });
        expect(s.provider_order_code).toMatch(/^GHNMOCK/);
        expect(s.client_order_code).toMatch(/^XS-[A-Z0-9]{6}-S1$/);
        expect(s).not.toHaveProperty("label_url");
        const body = ghn.lastCreateBody!;
        expect(body).toMatchObject({
          is_new_to_address: true,
          cod_amount: 0,
          payment_type_id: 1,
          to_province_name: "Thành phố Hà Nội",
          client_order_code: s.client_order_code,
        });
        expect(body).not.toHaveProperty("to_district_id");
        expect(String(body.to_ward_name)).toBeTruthy();
        expect(body.to_phone).toBe("0912345678");

        const again = await createShipment(o.orderId);
        expect(again.status).toBe(200);
        expect(shipmentOf(again).id).toBe(s.id);
        expect(ghn.createCalls).toBe(1);
      });
    });

    describe("COD — xác nhận bởi nhân viên rồi mới tạo vận đơn", () => {
      it("confirm-cod một lần (lặp → changed=false), COD = tổng đơn (gồm phí ship đã báo, không thu thêm)", async () => {
        const o = await client.placeOrder([["Trắng/M", 1]], "cod");
        const c1 = await confirmCod(o.orderId);
        expect(c1.data).toMatchObject({ state: "confirmed", changed: true });
        expect((await confirmCod(o.orderId)).data).toMatchObject({ changed: false });
        const outbox = await checkout().listOutboxEvents({
          aggregate_id: o.orderId,
          type: "order.confirmed",
        });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]!.payload).toMatchObject({ confirmed_by: staff.userId, payment_method: "cod" });

        const r = await createShipment(o.orderId);
        expect(r.status).toBe(201);
        expect(shipmentOf(r)).toMatchObject({ cod_amount: o.total, payer: "shop" });
        expect(ghn.lastCreateBody).toMatchObject({ cod_amount: o.total, payment_type_id: 1 });
      });
    });

    describe("AT11 — timeout khi tạo: tra theo client_order_code trước khi gửi lại", () => {
      it("hãng đã ghi nhưng trả timeout → tra thấy, nhận vận đơn; không tạo lần hai", async () => {
        const o = await paidVnpayOrder();
        ghn.createFaults.push("timeout_after_commit");
        const r = await createShipment(o.orderId);
        expect(r.status).toBe(201);
        expect(shipmentOf(r).provider_order_code).toMatch(/^GHNMOCK/);
        expect(ghn.mock.created).toBe(1);
      });

      it("timeout + API tra cứu sập → 202 pending; gọi lại → tra trước, thấy vận đơn cũ, không gửi lại", async () => {
        const o = await paidVnpayOrder();
        ghn.createFaults.push("timeout_after_commit");
        ghn.detailFailures = 1;
        const r1 = await createShipment(o.orderId);
        expect(r1.status).toBe(202);
        expect(shipmentOf(r1)).toMatchObject({ provider_order_code: null, state: "unfulfilled" });
        const r2 = await createShipment(o.orderId);
        expect(r2.status).toBe(201);
        expect(shipmentOf(r2).id).toBe(shipmentOf(r1).id);
        expect(ghn.createCalls).toBe(1);
        expect(ghn.mock.created).toBe(1);
      });

      it("timeout trước khi hãng ghi → 202; gọi lại → tra không thấy → gửi lại CÙNG client_order_code → 1 vận đơn", async () => {
        const o = await paidVnpayOrder();
        ghn.createFaults.push("timeout_before_commit");
        const r1 = await createShipment(o.orderId);
        expect(r1.status).toBe(202);
        const r2 = await createShipment(o.orderId);
        expect(r2.status).toBe(201);
        expect(ghn.createCalls).toBe(2);
        expect(ghn.mock.created).toBe(1);
        expect(await shipping().listShipments({ order_id: o.orderId })).toHaveLength(1);
      });
    });

    describe("song song — 2 nhân viên cùng tạo vận đơn", () => {
      it("khóa order + UNIQUE client_order_code → đúng 1 shipment, hãng nhận 1 lần", async () => {
        const o = await confirmedCodOrder();
        const other = await adminHeaders(api as unknown as HttpClient, container);
        ghn.createDelayMs = 300;
        const [a, b] = await Promise.all([
          createShipment(o.orderId),
          createShipment(o.orderId, other.headers),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(shipmentOf(a).id).toBe(shipmentOf(b).id);
        expect(await shipping().listShipments({ order_id: o.orderId })).toHaveLength(1);
        expect(ghn.createCalls).toBe(1);
        expect(ghn.mock.created).toBe(1);
      });
    });

    describe("callback GHN — không tin nội dung, đối chiếu API, lặp/sai thứ tự không lùi", () => {
      async function shippedOrder() {
        const o = await confirmedCodOrder();
        const s = shipmentOf(await createShipment(o.orderId));
        return { o, s, code: s.provider_order_code! };
      }
      const cb = (code: string, status: string, time: string, extra: Record<string, unknown> = {}) => ({
        OrderCode: code,
        Type: "Switch_status",
        Status: status,
        Time: time,
        CODAmount: 0,
        ...extra,
      });
      const current = async (id: string) => (await shipping().listShipments({ id }))[0]!;

      it("áp theo API; lặp → dedupe; callback giả 'delivered' khi API chưa giao → không đổi; mốc cũ đến muộn → không lùi; raw không PII", async () => {
        const { o, s, code } = await shippedOrder();
        ghn.setStatusByOrderCode(code, "delivering");
        const first = cb(code, "delivering", "2026-10-24T03:00:00Z", {
          ToName: "Nguyễn Văn An",
          ToPhone: "0912345678",
          ToAddress: "12 Phố Điện Biên Phủ",
          Reason: "Gọi 0912345678 không nghe",
        });
        expect((await callback(first)).data).toMatchObject({ ok: true, state: "shipped" });
        expect((await callback(first)).data).toMatchObject({ ok: true, duplicate: true });
        const events = await shipping().listShipmentEvents({ shipment_id: s.id });
        expect(events).toHaveLength(1);
        const raw = JSON.stringify(events[0]!.raw);
        expect(raw).not.toMatch(/0912345678|Nguyễn|Điện Biên|ToName|Reason/);
        expect(events[0]!.raw).toMatchObject({ OrderCode: code, Status: "delivering" });
        expect(
          await checkout().listOutboxEvents({ aggregate_id: o.orderId, type: "shipment.shipped" }),
        ).toHaveLength(1);

        // Callback nói "delivered" nhưng API có xác thực vẫn "delivering" → không đổi trạng thái (S-305).
        const forged = await callback(cb(code, "delivered", "2026-10-24T03:05:00Z"));
        expect(forged.data).toMatchObject({ state: "shipped", provider_status: "delivering" });
        expect((await current(s.id)).state).toBe("shipped");

        ghn.setStatusByOrderCode(code, "delivered");
        expect((await callback(cb(code, "delivered", "2026-10-24T05:00:00Z"))).data).toMatchObject({
          state: "delivered",
        });
        // Mốc cũ đến muộn (picking) và API tạm trả trạng thái cũ hơn → không lùi.
        expect((await callback(cb(code, "picking", "2026-10-24T01:00:00Z"))).data).toMatchObject({
          state: "delivered",
          ignored: "duplicate",
        });
        ghn.setStatusByOrderCode(code, "delivering");
        expect((await callback(cb(code, "delivering", "2026-10-24T02:00:00Z"))).data).toMatchObject({
          state: "delivered",
          ignored: "out_of_order",
        });
        const after = await current(s.id);
        expect(after.state).toBe("delivered");
        expect(after.delivered_at).not.toBeNull();
        expect(
          await checkout().listOutboxEvents({ aggregate_id: o.orderId, type: "shipment.shipped" }),
        ).toHaveLength(1);
      });

      it("mất mốc trung gian: đang packed, API báo delivered → đi packed→shipped→delivered hợp lệ", async () => {
        const { s, code } = await shippedOrder();
        ghn.setStatusByOrderCode(code, "delivered");
        expect((await callback(cb(code, "delivered", "2026-10-24T05:00:00Z"))).data).toMatchObject({
          state: "delivered",
        });
        expect((await current(s.id)).state).toBe("delivered");
      });

      it("API tra cứu sập → 503, sự kiện chưa applied; hãng gửi lại cùng sự kiện → xử lý tiếp", async () => {
        const { s, code } = await shippedOrder();
        ghn.setStatusByOrderCode(code, "picked");
        ghn.detailFailures = 1;
        const body = cb(code, "picked", "2026-10-24T03:00:00Z");
        expect((await callback(body)).status).toBe(503);
        expect((await shipping().listShipmentEvents({ shipment_id: s.id }))[0]!.applied).toBe(false);
        expect((await callback(body)).data).toMatchObject({ state: "shipped" });
        const events = await shipping().listShipmentEvents({ shipment_id: s.id });
        expect(events.map((e) => e.applied)).toEqual([true]);
      });

      it("dị dạng → 400; vận đơn lạ → 200 bỏ qua; callback lặp song song → 1 sự kiện", async () => {
        expect((await callback({ OrderCode: "x" })).status).toBe(400);
        expect((await callback(cb("GHNKHONGCO", "delivered", "t"))).data).toMatchObject({
          ignored: "unknown_shipment",
        });
        const { s, code } = await shippedOrder();
        ghn.setStatusByOrderCode(code, "delivering");
        const body = cb(code, "delivering", "2026-10-24T03:00:00Z");
        const rs = await Promise.all(Array.from({ length: 5 }, () => callback(body)));
        expect(rs.every((r) => r.status === 200 || r.status === 503)).toBe(true);
        expect(await shipping().listShipmentEvents({ shipment_id: s.id })).toHaveLength(1);
        expect((await current(s.id)).state).toBe("shipped");
      });
    });

    describe("AT14 — delivered ≠ settled", () => {
      it("giao xong + courier báo đã chuyển COD → vẫn unsettled, có số phải thu", async () => {
        const o = await confirmedCodOrder();
        const s = shipmentOf(await createShipment(o.orderId));
        const code = s.provider_order_code!;
        ghn.setStatusByOrderCode(code, "delivered");
        await callback({
          OrderCode: code,
          Type: "Switch_status",
          Status: "delivered",
          Time: "2026-10-24T05:00:00Z",
        });
        let row = (await shipping().listShipments({ id: s.id }))[0]!;
        expect(row).toMatchObject({ state: "delivered", settlement_state: "unsettled" });
        expect(await shipping().codReceivable()).toEqual({ shipments: 1, amount: o.total, reported: 0 });

        const cod = await callback({
          OrderCode: code,
          Type: "cod",
          Status: "",
          Time: "2026-10-26T08:00:00Z",
          CODAmount: o.total,
        });
        expect(cod.data).toMatchObject({ cod_reported: true, settlement_state: "unsettled" });
        row = (await shipping().listShipments({ id: s.id }))[0]!;
        expect(row).toMatchObject({ settlement_state: "unsettled", cod_reported_amount: o.total });
        expect(await shipping().codReceivable()).toEqual({ shipments: 1, amount: o.total, reported: 1 });
      });
    });
  },
});
