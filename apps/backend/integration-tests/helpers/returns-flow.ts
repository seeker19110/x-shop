import { randomUUID } from "node:crypto";
import type { MockModeVnpayGateway } from "../../src/lib/checkout/vnpay-gateway";
import type { MockModeGhnClient } from "../../src/lib/shipping/ghn-client";
import { checkoutClient, ipn, type Api, type Res } from "./checkout-api";
import type { CatalogFixture } from "./checkout-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- thân JSON của API test không có kiểu; kiểm bằng expect từng trường
export type J = Record<string, any>;

export interface PlacedOrder {
  cartId: string;
  orderId: string;
  ref: string;
  total: number;
  paymentUrl: string;
  access: string;
}

let ipSeq = 0;
/** Mỗi ca một IP giả (x-forwarded-for) — bộ đếm giới hạn tần suất theo IP của route đơn không lẫn giữa các ca. */
export const newIp = () => `10.27.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
export const key = () => `rt-${randomUUID()}`;

/**
 * Luồng đơn thật qua HTTP cho test đổi trả/hoàn tiền: submit → thanh toán (IPN VNPAY giả lập) hoặc xác nhận COD →
 * tạo vận đơn GHN (mock) → callback "delivered" đã đối chiếu API hãng. Không chèn thẳng DB.
 */
export function returnsFlow(
  api: Api,
  deps: {
    fx: () => CatalogFixture;
    gateway: () => MockModeVnpayGateway;
    ghn: () => MockModeGhnClient;
    staff: () => Record<string, string>;
    ip: () => string;
  },
) {
  const client = checkoutClient(api, deps.fx);
  const storeCfg = (extra: Record<string, string> = {}) =>
    client.cfg({ "x-forwarded-for": deps.ip(), ...extra });
  const adminCfg = (headers: Record<string, string>, extra: Record<string, string> = {}) => ({
    headers: { ...headers, ...extra },
    validateStatus: () => true,
  });

  async function place(
    items: Array<[string, number]>,
    method: "cod" | "vnpay",
    extra: object = {},
  ): Promise<PlacedOrder> {
    const cartId = await client.createCart(items);
    const q = await client.quote(cartId, { payment_method: method, ...extra });
    const res = (await client.submit(q)) as unknown as Res<J>;
    if (res.status !== 200) throw new Error(`submit lỗi ${res.status}: ${JSON.stringify(res.data)}`);
    const o: PlacedOrder = {
      cartId,
      orderId: res.data.order.id,
      ref: res.data.order.display_ref,
      total: res.data.order.total,
      paymentUrl: res.data.payment_url,
      access: res.data.order_access,
    };
    if (method === "vnpay") {
      const r = await ipn(api, deps.gateway().mock.pay(o.paymentUrl, "success"));
      if (r.data.RspCode !== "00") throw new Error(`IPN lỗi ${JSON.stringify(r.data)}`);
    } else {
      const r = await api.post(`/admin/x/orders/${o.orderId}/confirm-cod`, {}, adminCfg(deps.staff()));
      if (r.status !== 200) throw new Error(`xác nhận COD lỗi ${r.status}`);
    }
    return o;
  }

  /** Tạo vận đơn rồi hãng báo (và API xác nhận) đã giao. */
  async function deliver(o: PlacedOrder): Promise<J> {
    const created = (await api.post(
      `/admin/x/orders/${o.orderId}/shipments`,
      {},
      adminCfg(deps.staff()),
    )) as Res<J>;
    if (created.status !== 201)
      throw new Error(`tạo vận đơn lỗi ${created.status}: ${JSON.stringify(created.data)}`);
    const code = created.data.shipment.provider_order_code as string;
    deps.ghn().setStatusByOrderCode(code, "delivered");
    const cb = (await api.post(
      "/x/webhooks/shipping/ghn",
      {
        OrderCode: code,
        Type: "Switch_status",
        Status: "delivered",
        Time: new Date().toISOString(),
        CODAmount: 0,
      },
      { validateStatus: () => true },
    )) as Res<J>;
    if (cb.data.state !== "delivered") throw new Error(`callback giao lỗi ${JSON.stringify(cb.data)}`);
    return created.data.shipment;
  }

  async function deliveredOrder(items: Array<[string, number]>, method: "cod" | "vnpay", extra: object = {}) {
    const o = await place(items, method, extra);
    await deliver(o);
    return o;
  }

  const storeReturns = (o: PlacedOrder): Promise<Res<J>> =>
    api.get(`/store/x/orders/${o.ref}/returns`, storeCfg({ "x-order-access": o.access })) as Promise<Res<J>>;
  const requestReturn = (o: PlacedOrder, body: unknown, k: string = key()): Promise<Res<J>> =>
    api.post(
      `/store/x/orders/${o.ref}/returns`,
      body,
      storeCfg({ "x-order-access": o.access, "Idempotency-Key": k }),
    ) as Promise<Res<J>>;
  const cancel = (o: PlacedOrder): Promise<Res<J>> =>
    api.post(`/store/x/orders/${o.ref}/cancel`, {}, storeCfg({ "x-order-access": o.access })) as Promise<
      Res<J>
    >;
  const admin = (
    path: string,
    headers: Record<string, string>,
    body: unknown = {},
    extra: Record<string, string> = {},
  ): Promise<Res<J>> => api.post(path, body, adminCfg(headers, extra)) as Promise<Res<J>>;
  const adminGet = (path: string, headers: Record<string, string>): Promise<Res<J>> =>
    api.get(path, adminCfg(headers)) as Promise<Res<J>>;

  return { client, place, deliver, deliveredOrder, storeReturns, requestReturn, cancel, admin, adminGet };
}
