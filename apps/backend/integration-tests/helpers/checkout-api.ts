import { randomUUID } from "node:crypto";
import { VNPAY_DEV_DEFAULTS } from "../../src/lib/env";
import { HANOI_ADDRESS, type CatalogFixture } from "./checkout-fixtures";

/** Phần axios tối thiểu do test runner cấp (axios không là phụ thuộc trực tiếp của backend). */
export interface Res<B = Body> {
  status: number;
  data: B;
  headers: Record<string, string>;
}
export interface Api {
  get(url: string, config?: object): Promise<Res>;
  post(url: string, body?: unknown, config?: object): Promise<Res>;
}

export interface QuoteView {
  id: string;
  cart_id: string;
  cart_version: number;
  payment_method: string;
  discount_code: string | null;
  total: number;
}
export interface OrderView {
  id: string;
  display_ref: string;
  state: string;
  total: number;
  /** null với COD/khi không áp dụng — test so khớp null bằng matcher. */
  hold_expires_at: string;
  cod_confirm_by: string;
}
/** Hình JSON các route trả (khai đủ trường test đọc). */
export interface Body {
  cart: { id: string };
  quote: QuoteView;
  checkout_attempt_id: string;
  state: string;
  order: OrderView;
  payment_url: string;
  payment_check: string;
  code: string;
  RspCode: string;
  Message: string;
}

export const CONTACT = { name: "Nguyễn Văn An", phone: "0912 345 678", email: "an@example.test" };
export const DEV_VNPAY = {
  tmnCode: VNPAY_DEV_DEFAULTS.VNPAY_TMN_CODE,
  hashSecret: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET,
};
export const newKey = () => `k-${randomUUID()}`;

/** Client Store API cho luồng checkout: giỏ → quote → submit, dùng publishable key của fixture. */
export function checkoutClient(api: Api, fx: () => CatalogFixture) {
  const cfg = (extra: Record<string, string> = {}) => ({
    headers: { "x-publishable-api-key": fx().publishableKey, ...extra },
    validateStatus: () => true,
  });

  async function createCart(items: Array<[string, number]>): Promise<string> {
    const res = await api.post(
      "/store/carts",
      {
        region_id: fx().regionId,
        items: items.map(([k, quantity]) => ({ variant_id: fx().variants[k]!.id, quantity })),
      },
      cfg(),
    );
    if (res.status !== 200) throw new Error(`tạo giỏ lỗi ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data.cart.id;
  }

  async function quote(cartId: string, extra: Record<string, unknown> = {}): Promise<QuoteView> {
    const res = await api.post(
      "/store/x/checkout/quote",
      { cart_id: cartId, payment_method: "cod", address: HANOI_ADDRESS, ...extra },
      cfg(),
    );
    if (res.status !== 200) throw new Error(`quote lỗi ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data.quote;
  }

  const submitBody = (q: QuoteView) => ({
    cart_id: q.cart_id,
    cart_version: q.cart_version,
    quote_id: q.id,
    payment_method: q.payment_method,
    contact: CONTACT,
    address: HANOI_ADDRESS,
  });

  async function submit(q: QuoteView, key = newKey()): Promise<Res> {
    return api.post("/store/x/checkout/submit", submitBody(q), cfg({ "Idempotency-Key": key }));
  }

  /** Đặt một đơn hoàn chỉnh; trả thông tin cần cho test thanh toán. */
  async function placeOrder(
    items: Array<[string, number]>,
    method: "cod" | "vnpay",
    extra: Record<string, unknown> = {},
  ) {
    const cartId = await createCart(items);
    const q = await quote(cartId, { payment_method: method, ...extra });
    const res = await submit(q);
    if (res.status !== 200) throw new Error(`submit lỗi ${res.status}: ${JSON.stringify(res.data)}`);
    return {
      cartId,
      attemptId: res.data.checkout_attempt_id,
      orderId: res.data.order.id,
      total: res.data.order.total,
      paymentUrl: res.data.payment_url,
    };
  }

  return { cfg, createCart, quote, submit, submitBody, placeOrder };
}

/** Gọi IPN như VNPAY (GET, không publishable key). */
export function ipn(api: Api, params: URLSearchParams): Promise<Res> {
  return api.get(`/x/webhooks/vnpay/ipn?${params.toString()}`, { validateStatus: () => true });
}
