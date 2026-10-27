import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { listWards, vnpay } from "@x-shop/domain";
import Redis from "ioredis";
import { CHECKOUT_CONFIG } from "../../src/lib/checkout/config";
import { VNPAY_DEV_DEFAULTS } from "../../src/lib/env";
import { GhnError, MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import * as shippingRates from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { submitCheckoutWorkflow } from "../../src/workflows/checkout/submit-checkout";
import {
  countOrders,
  createPromotion,
  HANOI_ADDRESS,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  setPrice,
  setStock,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/** Hình JSON các route trả (khai đủ trường test đọc; route nào không có trường thì runtime là undefined). */
interface QuoteView {
  id: string;
  cart_id: string;
  cart_version: number;
  payment_method: string;
  discount_code: string | null;
  currency_code: string;
  subtotal: number;
  discount_total: number;
  shipping_fee: number;
  total: number;
  expires_at: string;
}
interface OrderView {
  id: string;
  display_ref: string;
  state: string;
  total: number;
  payment_method: string;
  /** null với COD — test so khớp giá trị null bằng matcher. */
  hold_expires_at: string;
  cod_confirm_by: string;
}
interface Body {
  cart: { id: string };
  token: string;
  quote: QuoteView;
  checkout_attempt_id: string;
  state: string;
  order: OrderView;
  payment_url: string;
  code: string;
  field: string;
  action: string;
  detail: string;
  status: number;
  lines: unknown[];
  replacement: string;
  trace_id: string;
}
/** Phần axios tối thiểu do test runner cấp. */
interface Res {
  status: number;
  data: Body;
  headers: Record<string, string>;
}
interface Api {
  get(url: string, config?: object): Promise<Res>;
  post(url: string, body?: unknown, config?: object): Promise<Res>;
}

const newKey = () => `k-${randomUUID()}`;
const CONTACT = { name: "Nguyễn Văn An", phone: "0912 345 678", email: "an@example.test" };

/** Giỏ mà test runner nhắm tới (cart_id) — handler hook làm lỗi bước cuối để kiểm bù trừ. */
const failBeforeFinalize = new Set<string>();

/** Khóa còn sót trong Redis (tiền tố mặc định của provider locking-redis) cho các khóa checkout đã cho. */
async function leakedLocks(keys: string[]): Promise<string[]> {
  const redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
  try {
    const values = await Promise.all(keys.map((k) => redis.get(`medusa_lock:${k}`)));
    return keys.filter((_, i) => values[i] !== null);
  } finally {
    await redis.quit();
  }
}
/** GHN giả lập có núm cho T-153: đếm lần báo phí, đổi phí, đổi mã dịch vụ trả về, sập. */
class ScriptedGhn extends MockModeGhnClient {
  quoteCalls = 0;
  feeOverride: number | null = null;
  serviceOverride: string | null = null;
  down = false;
  override async quoteFee(input: Parameters<MockModeGhnClient["quoteFee"]>[0]) {
    this.quoteCalls += 1;
    if (this.down) throw new GhnError("unavailable", "GHN sập (giả lập)", { status: 503 });
    const fee = await super.quoteFee(input);
    return {
      fee: this.feeOverride ?? fee.fee,
      service: this.serviceOverride ?? fee.service,
    };
  }
}

/**
 * CHỈ để đối chứng với mã trước T-153: mã đó giữ cache phí trong bộ nhớ (`clearShippingFeeCache`), gọi hàm này = submit ở
 * bản sao có cache trống → test đỏ. Ở mã hiện tại hàm KHÔNG LÀM GÌ (không còn trạng thái báo phí trong tiến trình).
 * Bằng chứng submit không phụ thuộc tiến trình nằm ở cặp test: "GHN sập → 200, không gọi GHN" (phí lấy từ DB, không từ
 * hãng hay bộ nhớ) và "`shipping: null` → 503" (bỏ ảnh chụp trong DB thì không còn nguồn nào khác để dùng lại phí).
 */
async function asOtherReplica(): Promise<void> {
  const clear = (shippingRates as Record<string, unknown>)["clearShippingFeeCache"];
  if (typeof clear === "function") await (clear as () => unknown)();
}

/** Giỏ → độ trễ (ms) trước khi chốt — giữ attempt ở `preparing` để kiểm nhánh 202. */
const slowBeforeFinalize = new Map<string, number>();
submitCheckoutWorkflow.hooks.orderPrepared(async ({ cart_id }) => {
  if (failBeforeFinalize.has(cart_id)) throw new Error("lỗi giả lập trước khi chốt đơn");
  const delay = slowBeforeFinalize.get(cart_id);
  if (delay) await new Promise((r) => setTimeout(r, delay));
});

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;

    const headers = (extra: Record<string, string> = {}) => ({
      "x-publishable-api-key": fx.publishableKey,
      ...extra,
    });
    const cfg = (extra: Record<string, string> = {}) => ({
      headers: headers(extra),
      validateStatus: () => true,
    });

    async function createCart(items: Array<[string, number]>, auth?: string): Promise<string> {
      const res = await api.post(
        "/store/carts",
        {
          region_id: fx.regionId,
          items: items.map(([key, quantity]) => ({ variant_id: fx.variants[key]!.id, quantity })),
        },
        cfg(auth ? { authorization: `Bearer ${auth}` } : {}),
      );
      expect({ status: res.status, data: res.status === 200 ? null : res.data }).toEqual({
        status: 200,
        data: null,
      });
      return res.data.cart.id as string;
    }

    async function quote(cartId: string, extra: Record<string, unknown> = {}, auth?: string) {
      return api.post(
        "/store/x/checkout/quote",
        { cart_id: cartId, payment_method: "cod", address: HANOI_ADDRESS, ...extra },
        cfg(auth ? { authorization: `Bearer ${auth}` } : {}),
      );
    }

    function submitBody(q: QuoteView, extra: Record<string, unknown> = {}) {
      return {
        cart_id: q.cart_id,
        cart_version: q.cart_version,
        quote_id: q.id,
        payment_method: q.payment_method,
        contact: CONTACT,
        address: HANOI_ADDRESS,
        ...extra,
      };
    }

    async function submit(body: Record<string, unknown>, key = newKey(), auth?: string) {
      return api.post(
        "/store/x/checkout/submit",
        body,
        cfg({ "Idempotency-Key": key, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }),
      );
    }

    async function quoteOk(cartId: string, extra: Record<string, unknown> = {}, auth?: string) {
      const res = await quote(cartId, extra, auth);
      expect({ status: res.status, data: res.status === 200 ? null : res.data }).toEqual({
        status: 200,
        data: null,
      });
      return res.data.quote;
    }

    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container);
    });

    describe("quote", () => {
      it("S-001: breakdown số nguyên VND từ giá hiện hành, có cart_version và hạn 10 phút", async () => {
        const cartId = await createCart([
          ["Đen/M", 1],
          ["Trắng/S", 2],
        ]);
        const before = Date.now();
        const q = await quoteOk(cartId);
        expect(q).toMatchObject({
          cart_id: cartId,
          cart_version: 1,
          currency_code: "vnd",
          subtotal: 1_300_000,
          discount_total: 0,
          shipping_fee: 30_000,
          total: 1_330_000,
        });
        const exp = new Date(q.expires_at).getTime();
        expect(exp - before).toBeGreaterThanOrEqual(10 * 60_000 - 5_000);
        expect(exp - before).toBeLessThanOrEqual(10 * 60_000 + 5_000);
        // Báo giá lại khi giỏ không đổi → cùng phiên bản; đổi giỏ → phiên bản tăng.
        expect((await quoteOk(cartId)).cart_version).toBe(1);
        const add = await api.post(
          `/store/carts/${cartId}/line-items`,
          { variant_id: fx.variants["Trắng/M"]!.id, quantity: 1 },
          cfg(),
        );
        expect(add.status).toBe(200);
        expect((await quoteOk(cartId)).cart_version).toBe(2);
      });

      it("lỗi dữ liệu → 422 problem+json có field; mã giảm không tồn tại → 422 DISCOUNT_NOT_APPLICABLE", async () => {
        const cartId = await createCart([["Đen/S", 1]]);
        const bad = await quote(cartId, { address: { ...HANOI_ADDRESS, ward_code: "99999" } });
        expect(bad.status).toBe(422);
        expect(bad.headers["content-type"]).toMatch(/^application\/problem\+json/);
        expect(bad.data).toMatchObject({ code: "VALIDATION", field: "address.ward_code" });
        const extra = await quote(cartId, { total: 1 });
        expect(extra.data).toMatchObject({ code: "VALIDATION", field: "total" });
        const code = await quote(cartId, { discount_code: "KHONGCO" });
        expect(code.status).toBe(422);
        expect(code.data).toMatchObject({ code: "DISCOUNT_NOT_APPLICABLE", field: "discount_code" });
      });
    });

    describe("submit COD / VNPAY", () => {
      it("S-009 COD → 200 placed + reservation gắn line_item đúng một bộ; snapshot không đổi khi giá đổi sau", async () => {
        const cartId = await createCart([
          ["Đen/M", 1],
          ["Trắng/S", 2],
        ]);
        const q = await quoteOk(cartId);
        const before = Date.now();
        const res = await submit(submitBody(q));
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          state: "ready",
          cart_id: cartId,
          payment_method: "cod",
          payment_url: null,
          order: { state: "placed", total: 1_330_000, payment_method: "cod", hold_expires_at: null },
        });
        expect(res.data.order.display_ref).toMatch(/^XS-[0-9A-Z]{6}$/);
        const codBy = new Date(res.data.order.cod_confirm_by).getTime() - before;
        expect(codBy).toBeGreaterThanOrEqual(24 * 3600_000 - 10_000);
        expect(codBy).toBeLessThanOrEqual(24 * 3600_000 + 10_000);

        // Đơn native: tổng khớp quote, mỗi dòng giỏ một dòng đơn; giỏ KHÔNG bị complete bởi Medusa.
        const order = await container
          .resolve(Modules.ORDER)
          .retrieveOrder(res.data.order.id, { relations: ["items"] });
        expect(Number(order.total)).toBe(1_330_000);
        expect(order.items).toHaveLength(2);
        const cart = await container.resolve(Modules.CART).retrieveCart(cartId);
        expect(cart.completed_at).toBeNull();

        // Reservation đúng một bộ, gắn line_item của đơn.
        const orderLineIds = new Set(order.items!.map((i) => i.id));
        const black = await reservationsOf(container, fx, "Đen/M");
        const white = await reservationsOf(container, fx, "Trắng/S");
        expect(black.map((r) => Number(r.quantity))).toEqual([1]);
        expect(white.map((r) => Number(r.quantity))).toEqual([2]);
        for (const r of [...black, ...white]) expect(orderLineIds.has(r.line_item_id as string)).toBe(true);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 1 });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 10, reserved: 2 });

        // order_finance + outbox (thông báo đi qua outbox, sau finalization).
        const [fin] = await service().listOrderFinances({ order_id: order.id });
        expect(fin).toMatchObject({ state: "placed", total: 1_330_000, policy_version: "2026-10-24" });
        const outbox = await service().listOutboxEvents({ aggregate_id: order.id });
        expect(outbox.map((e) => e.type)).toEqual(["order.placed_pending"]);

        // DATA05: đổi giá sau khi đặt → snapshot đơn giữ nguyên.
        await setPrice(container, fx.variants["Đen/M"]!.id, 999_000);
        const [finAfter] = await service().listOrderFinances({ order_id: order.id });
        expect((finAfter!.quote as { total: number }).total).toBe(1_330_000);
        expect(
          (finAfter!.quote as { lines: Array<{ unitPrice: number }> }).lines.map((l) => l.unitPrice).sort(),
        ).toEqual([300_000, 700_000]);

        // Trạng thái attempt: chủ giỏ xem được; sai cart_id → 404.
        const status = await api.get(
          `/store/x/checkout/attempts/${res.data.checkout_attempt_id}?cart_id=${cartId}`,
          cfg(),
        );
        expect(status.status).toBe(200);
        expect(status.data.order.id).toBe(order.id);
        const wrong = await api.get(
          `/store/x/checkout/attempts/${res.data.checkout_attempt_id}?cart_id=cart_khac`,
          cfg(),
        );
        expect(wrong.status).toBe(404);
      });

      it("VNPAY → awaiting_payment, giữ 15 phút, payment_attempt pending, payment_url ký hợp lệ", async () => {
        const cartId = await createCart([["Đen/S", 2]]);
        const q = await quoteOk(cartId, { payment_method: "vnpay" });
        const before = Date.now();
        const res = await submit(submitBody(q));
        expect(res.status).toBe(200);
        expect(res.data.order).toMatchObject({
          state: "awaiting_payment",
          total: 1_430_000,
          cod_confirm_by: null,
        });
        const hold = new Date(res.data.order.hold_expires_at).getTime() - before;
        expect(hold).toBeGreaterThanOrEqual(15 * 60_000 - 10_000);
        expect(hold).toBeLessThanOrEqual(15 * 60_000 + 10_000);

        const [pa] = await service().listPaymentAttempts({ order_id: res.data.order.id });
        expect(pa).toMatchObject({ state: "pending", provider: "vnpay", amount: 1_430_000 });
        expect(pa!.txn_ref).toMatch(/^PA_[0-9A-Z]{26}$/);

        const url = new URL(res.data.payment_url);
        expect(`${url.origin}${url.pathname}`).toBe(VNPAY_DEV_DEFAULTS.VNPAY_PAYMENT_URL);
        const params = Object.fromEntries(url.searchParams.entries());
        // Tính lại chữ ký HMAC-SHA512 trên tham số vnp_* đã sắp xếp (đúng thuật toán của verifyNotification).
        expect(params.vnp_SecureHash).toBe(
          vnpay.hmacSha512(VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET, vnpay.signData(params)),
        );
        expect(params).toMatchObject({
          vnp_Amount: String(1_430_000 * 100),
          vnp_TxnRef: pa!.txn_ref,
          vnp_TmnCode: VNPAY_DEV_DEFAULTS.VNPAY_TMN_CODE,
          vnp_CurrCode: "VND",
          vnp_ExpireDate: vnpay.toVnpDate(new Date(res.data.order.hold_expires_at)),
        });
        // Vòng khứ hồi qua mock cổng: IPN sinh từ URL này qua được verifyNotification với cùng khoá.
        const gateway = new vnpay.MockVnpayGateway({
          tmnCode: VNPAY_DEV_DEFAULTS.VNPAY_TMN_CODE,
          hashSecret: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET,
        });
        const verified = vnpay.verifyNotification(
          { tmnCode: VNPAY_DEV_DEFAULTS.VNPAY_TMN_CODE, hashSecret: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET },
          gateway.pay(res.data.payment_url, "success"),
        );
        expect(verified).toMatchObject({ ok: true, value: { txnRef: pa!.txn_ref, amount: 1_430_000 } });
        // Chữ ký bị sửa (đổi số tiền) → không hợp lệ.
        const tampered = new URLSearchParams(url.search);
        tampered.set("vnp_Amount", "100");
        expect(
          vnpay.hmacSha512(
            VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET,
            vnpay.signData(Object.fromEntries(tampered)),
          ),
        ).not.toBe(params.vnp_SecureHash);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 10, reserved: 2 });
      });
    });

    describe("AT03 — giá đổi giữa quote và submit", () => {
      it("409 PRICE_CHANGED kèm quote mới; không đơn, không reservation; xác nhận quote mới thì đặt được", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q1 = await quoteOk(cartId);
        expect(q1.total).toBe(730_000);
        await setPrice(container, fx.variants["Đen/M"]!.id, 750_000);

        const res = await submit(submitBody(q1));
        expect(res.status).toBe(409);
        expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
        expect(res.data).toMatchObject({ code: "PRICE_CHANGED", action: "confirm_new_quote", status: 409 });
        expect(res.data.detail).toMatch(/Giá/);
        expect(res.data.quote).toMatchObject({ cart_id: cartId, cart_version: 1, total: 780_000 });
        expect(await countOrders(container)).toBe(0);
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });

        // Khách xác nhận tổng mới (quote mới, key mới) → đặt được, đúng tổng mới.
        const ok = await submit(submitBody(res.data.quote));
        expect(ok.status).toBe(200);
        expect(ok.data.order.total).toBe(780_000);
        expect(await countOrders(container)).toBe(1);
      });

      it("giỏ đổi sau quote → 409 CART_CHANGED; quote hết hạn → 409 QUOTE_EXPIRED", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        const add = await api.post(
          `/store/carts/${cartId}/line-items`,
          { variant_id: fx.variants["Trắng/M"]!.id, quantity: 1 },
          cfg(),
        );
        expect(add.status).toBe(200);
        const changed = await submit(submitBody(q));
        expect(changed.status).toBe(409);
        expect(changed.data.code).toBe("CART_CHANGED");

        const q2 = await quoteOk(cartId);
        await service().updateCheckoutQuotes({ id: q2.id, expires_at: new Date(Date.now() - 1000) });
        const expired = await submit(submitBody(q2));
        expect(expired.status).toBe(409);
        expect(expired.data.code).toBe("QUOTE_EXPIRED");
        expect(await countOrders(container)).toBe(0);
      });
    });

    describe("T-153 — phí ship đã báo còn hiệu lực từ quote tới submit, qua mọi bản sao", () => {
      let ghn: ScriptedGhn;
      beforeEach(() => {
        ghn = new ScriptedGhn();
        setGhnClientForTest(ghn);
      });
      afterEach(() => setGhnClientForTest(null));

      const otherWard = () => listWards("01").find((w) => w.code !== HANOI_ADDRESS.ward_code)!.code;
      const storedQuote = async (id: string) => (await service().listCheckoutQuotes({ id }))[0]!;

      it("quote ở bản B, GHN sập, submit ở bản A (cache trống), quote còn hạn → 200 đúng phí đã báo, không hỏi GHN", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        expect([q.shipping_fee, q.total, ghn.quoteCalls]).toEqual([30_000, 730_000, 1]);
        ghn.down = true;
        await asOtherReplica();

        const res = await submit(submitBody(q));
        expect({ status: res.status, code: res.data.code }).toEqual({ status: 200, code: undefined });
        expect(res.data.order.total).toBe(730_000);
        expect(ghn.quoteCalls).toBe(1);
        expect(await countOrders(container)).toBe(1);
      });

      it("GHN đổi phí trong hạn quote, submit ở bản A (cache trống) → đặt với phí đã báo 30 000, không SHIPPING_CHANGED", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        ghn.feeOverride = 32_000;
        await asOtherReplica();

        const res = await submit(submitBody(q));
        expect({ status: res.status, code: res.data.code }).toEqual({ status: 200, code: undefined });
        expect(res.data.order.total).toBe(730_000);
        expect(ghn.quoteCalls).toBe(1);
      });

      it("hãng trả mã dịch vụ khác cấu hình → phí vẫn dùng lại khi đầu vào không đổi; đơn ghi mã hãng trả", async () => {
        ghn.serviceOverride = "53320";
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        expect((q as unknown as { shipping_quote: { service: string } }).shipping_quote.service).toBe(
          "53320",
        );
        ghn.down = true;

        const res = await submit(submitBody(q));
        expect({ status: res.status, code: res.data.code }).toEqual({ status: 200, code: undefined });
        expect(res.data.order.total).toBe(730_000);
        expect(ghn.quoteCalls).toBe(1);
        const { data } = await container.resolve("query").graph({
          entity: "order",
          fields: ["id", "shipping_methods.data"],
          filters: { id: res.data.order.id },
        });
        const methods = (data[0] as { shipping_methods: Array<{ data: { service?: string } }> })
          .shipping_methods;
        expect(methods.map((m) => m.data.service)).toEqual(["53320"]);
      });

      it("đồng thời: GHN sập, hai tab submit song song ở bản sao cache trống → một đơn, đúng phí đã báo", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        ghn.down = true;
        await asOtherReplica();

        const [a, b] = await Promise.all([submit(submitBody(q)), submit(submitBody(q))]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.data.order.id).toBe(b.data.order.id);
        expect(a.data.order.total).toBe(730_000);
        expect(await countOrders(container)).toBe(1);
        expect(ghn.quoteCalls).toBe(1);
      });

      it("đổi phường lúc submit → hỏi lại GHN; phí khác → 409 SHIPPING_CHANGED kèm quote mới; xác nhận thì đặt đúng phí mới", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        ghn.feeOverride = 35_000;
        const moved = { ...HANOI_ADDRESS, ward_code: otherWard() };

        const res = await submit(submitBody(q, { address: moved }));
        expect(res.status).toBe(409);
        expect(res.data).toMatchObject({ code: "SHIPPING_CHANGED", action: "confirm_new_quote" });
        expect(res.data.quote).toMatchObject({ shipping_fee: 35_000, total: 735_000 });
        expect(ghn.quoteCalls).toBe(2);
        expect(await countOrders(container)).toBe(0);

        // Quote mới mang báo phí mới: xác nhận ngay → dùng lại phí đó (không hỏi GHN lần nữa).
        const ok = await submit(submitBody(res.data.quote, { address: moved }));
        expect(ok.status).toBe(200);
        expect(ok.data.order.total).toBe(735_000);
        expect(ghn.quoteCalls).toBe(2);
      });

      it("đổi phường mà phí như cũ → hỏi lại GHN rồi đặt được; đổi phường khi GHN sập → 503, không đặt bằng phí cũ", async () => {
        const moved = { ...HANOI_ADDRESS, ward_code: otherWard() };
        const c1 = await createCart([["Đen/M", 1]]);
        const q1 = await quoteOk(c1);
        const same = await submit(submitBody(q1, { address: moved }));
        expect(same.status).toBe(200);
        expect(same.data.order.total).toBe(730_000);
        expect(ghn.quoteCalls).toBe(2);

        const c2 = await createCart([["Trắng/M", 1]]);
        const q2 = await quoteOk(c2);
        ghn.down = true;
        const down = await submit(submitBody(q2, { address: moved }));
        expect(down.status).toBe(503);
        expect(down.data.code).toBe("SHIPPING_UNAVAILABLE");
        expect(await countOrders(container)).toBe(1);
      });

      it("khối lượng giỏ đổi (cân nặng biến thể sửa sau quote, giỏ giữ nguyên) → hỏi lại GHN, 409 SHIPPING_CHANGED", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        await container
          .resolve(Modules.PRODUCT)
          .updateProductVariants(fx.variants["Đen/M"]!.id, { weight: 2_000 });

        const res = await submit(submitBody(q));
        expect(res.status).toBe(409);
        expect(res.data.code).toBe("SHIPPING_CHANGED");
        // Bảng phí giả lập: 30 000 tới 1 kg + 5 000 mỗi 500 g → 2 kg = 40 000.
        expect(res.data.quote).toMatchObject({ shipping_fee: 40_000 });
        expect(ghn.quoteCalls).toBe(2);
        expect(await countOrders(container)).toBe(0);
      });

      it("đổi phương thức thanh toán so với quote → không dùng lại phí đã báo (GHN sập → 503)", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        ghn.down = true;
        const res = await submit(submitBody(q, { payment_method: "vnpay" }));
        expect(res.status).toBe(503);
        expect(res.data.code).toBe("SHIPPING_UNAVAILABLE");
      });

      it("quote hết hạn → QUOTE_EXPIRED, quote lại thì hỏi GHN; báo phí hết hạn (quote còn hạn) → hỏi lại, phí khác → SHIPPING_CHANGED", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q1 = await quoteOk(cartId);
        ghn.feeOverride = 32_000;
        await service().updateCheckoutQuotes({ id: q1.id, expires_at: new Date(Date.now() - 1000) });
        const expired = await submit(submitBody(q1));
        expect(expired.data.code).toBe("QUOTE_EXPIRED");
        expect(ghn.quoteCalls).toBe(1);
        const q2 = await quoteOk(cartId);
        expect(q2.shipping_fee).toBe(32_000);
        expect(ghn.quoteCalls).toBe(2);

        ghn.feeOverride = 34_000;
        const stored = await storedQuote(q2.id);
        await service().updateCheckoutQuotes({
          id: q2.id,
          shipping: { ...stored.shipping, expiresAt: new Date(Date.now() - 1000).toISOString() },
        });
        const stale = await submit(submitBody(q2));
        expect(stale.status).toBe(409);
        expect(stale.data.code).toBe("SHIPPING_CHANGED");
        expect(stale.data.quote).toMatchObject({ shipping_fee: 34_000 });
        expect(ghn.quoteCalls).toBe(3);
      });

      it("quote không có báo phí lưu kèm (tạo trước T-153) → hỏi lại GHN (sập → 503)", async () => {
        const cartId = await createCart([["Đen/M", 1]]);
        const q = await quoteOk(cartId);
        await service().updateCheckoutQuotes({ id: q.id, shipping: null });
        ghn.down = true;
        const res = await submit(submitBody(q));
        expect(res.status).toBe(503);
        expect(res.data.code).toBe("SHIPPING_UNAVAILABLE");
      });

      it("chỉ quote của chính giỏ mới cho mượn phí: quote_id của giỏ khác → 422; quote của giỏ mình → 200", async () => {
        const mine = await createCart([["Đen/M", 1]]);
        const other = await createCart([["Đen/M", 1]]);
        const qOther = await quoteOk(other);
        const qMine = await quoteOk(mine);
        ghn.down = true;
        const denied = await submit({ ...submitBody(qMine), quote_id: qOther.id });
        expect(denied.status).toBe(422);
        expect(denied.data).toMatchObject({ code: "VALIDATION", field: "quote_id" });
        const allowed = await submit(submitBody(qMine));
        expect(allowed.status).toBe(200);
        expect(allowed.data.order.total).toBe(730_000);
      });
    });

    describe("AT04 — 50 giỏ tranh món cuối", () => {
      it("SKU còn 1, 50 submit đồng thời → đúng 1 thành công, 49 × 409 INSUFFICIENT_STOCK, reserved = 1", async () => {
        await setStock(container, fx, "Trắng/M", 1);
        const carts = await Promise.all(Array.from({ length: 50 }, () => createCart([["Trắng/M", 1]])));
        const quotes = await Promise.all(carts.map((c) => quoteOk(c)));

        const results = await Promise.all(quotes.map((q) => submit(submitBody(q))));

        const ok = results.filter((r) => r.status === 200);
        const lost = results.filter((r) => r.status === 409);
        expect(ok).toHaveLength(1);
        expect(lost).toHaveLength(49);
        for (const r of lost) {
          expect(r.data.code).toBe("INSUFFICIENT_STOCK");
          expect(r.data.lines).toEqual([
            expect.objectContaining({ variant_id: fx.variants["Trắng/M"]!.id, requested: 1, available: 0 }),
          ]);
        }
        const level = await inventoryLevel(container, fx, "Trắng/M");
        expect(level).toEqual({ stocked: 1, reserved: 1 });
        expect(level.stocked - level.reserved).toBeGreaterThanOrEqual(0);
        expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(1);
        expect(await countOrders(container)).toBe(1);
        // Mọi khóa (giỏ + tồn kho) đã nhả — cả bên thắng lẫn 49 bên bù trừ.
        expect(
          await leakedLocks([
            `inventory_item:${fx.variants["Trắng/M"]!.inventoryItemId}`,
            ...carts.map((c) => `cart:${c}`),
          ]),
        ).toEqual([]);
      });
    });

    describe("AT05 — idempotency, double click, hai tab", () => {
      it("cùng Idempotency-Key ×10 đồng thời → 1 đơn; mọi response cùng attempt/order id", async () => {
        const cartId = await createCart([["Đen/S", 1]]);
        const q = await quoteOk(cartId);
        const key = newKey();
        const results = await Promise.all(Array.from({ length: 10 }, () => submit(submitBody(q), key)));
        for (const r of results) expect(r.status).toBe(200);
        expect(new Set(results.map((r) => r.data.checkout_attempt_id)).size).toBe(1);
        expect(new Set(results.map((r) => r.data.order.id)).size).toBe(1);
        expect(await countOrders(container)).toBe(1);
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 10, reserved: 1 });

        // Retry tuần tự cùng key + cùng payload → cùng kết quả.
        const again = await submit(submitBody(q), key);
        expect(again.status).toBe(200);
        expect(again.data.order.id).toBe(results[0]!.data.order.id);

        // Cùng key, khác payload → 409 IDEMPOTENCY_CONFLICT.
        const conflict = await submit(submitBody(q, { contact: { ...CONTACT, name: "Người Khác" } }), key);
        expect(conflict.status).toBe(409);
        expect(conflict.data.code).toBe("IDEMPOTENCY_CONFLICT");

        // Khác key, cùng cart_version (tab thứ hai) → trả attempt hiện có, không tạo đơn thứ hai.
        const tab2 = await submit(submitBody(q), newKey());
        expect(tab2.status).toBe(200);
        expect(tab2.data.checkout_attempt_id).toBe(results[0]!.data.checkout_attempt_id);
        expect(tab2.data.order.id).toBe(results[0]!.data.order.id);
        expect(await countOrders(container)).toBe(1);
      });

      it("hai tab submit ĐỒNG THỜI với key khác nhau → một attempt, một đơn", async () => {
        const cartId = await createCart([["Trắng/S", 1]]);
        const q = await quoteOk(cartId);
        const [a, b] = await Promise.all([submit(submitBody(q), newKey()), submit(submitBody(q), newKey())]);
        expect([a!.status, b!.status]).toEqual([200, 200]);
        expect(a!.data.checkout_attempt_id).toBe(b!.data.checkout_attempt_id);
        expect(a!.data.order.id).toBe(b!.data.order.id);
        expect(await countOrders(container)).toBe(1);
      });

      it("thiếu/sai Idempotency-Key → 422 VALIDATION", async () => {
        const cartId = await createCart([["Trắng/S", 1]]);
        const q = await quoteOk(cartId);
        const res = await submit(submitBody(q), "ngan");
        expect(res.status).toBe(422);
        expect(res.data).toMatchObject({ code: "VALIDATION", field: "Idempotency-Key" });
      });
    });

    describe("202 — đã nhận, đang xử lý", () => {
      it("request trùng khi attempt còn preparing quá thời gian chờ → 202 + Location; xong thì status trả ready", async () => {
        const cartId = await createCart([["Đen/S", 1]]);
        const q = await quoteOk(cartId);
        const mutableConfig = CHECKOUT_CONFIG as { replayWaitMs: number };
        const oldWait = mutableConfig.replayWaitMs;
        mutableConfig.replayWaitMs = 200;
        slowBeforeFinalize.set(cartId, 2_000);
        try {
          const key = newKey();
          const first = submit(submitBody(q), key);
          await new Promise((r) => setTimeout(r, 500));
          const second = await submit(submitBody(q), key);
          expect(second.status).toBe(202);
          expect(second.data.state).toBe("preparing");
          const statusUrl = `/store/x/checkout/attempts/${second.data.checkout_attempt_id}?cart_id=${cartId}`;
          expect(second.headers.location).toBe(statusUrl);
          expect(second.headers["retry-after"]).toBe("1");
          const done = await first;
          expect(done.status).toBe(200);
          expect(done.data.checkout_attempt_id).toBe(second.data.checkout_attempt_id);
          const status = await api.get(statusUrl, cfg());
          expect(status.data).toMatchObject({ state: "ready", order: { id: done.data.order.id } });
          expect(await countOrders(container)).toBe(1);
        } finally {
          mutableConfig.replayWaitMs = oldWait;
          slowBeforeFinalize.delete(cartId);
        }
      });
    });

    describe("AT33 — mã giảm còn 1 lượt", () => {
      it("20 checkout đồng thời dùng mã → đúng 1 dùng được, 19 × 409 DISCOUNT_EXHAUSTED", async () => {
        await createPromotion(container, "CUOI1", { limit: 1, percent: 10 });
        const keys = Object.keys(fx.variants);
        const carts = await Promise.all(
          Array.from({ length: 20 }, (_, i) => createCart([[keys[i % keys.length]!, 1]])),
        );
        const quotes = await Promise.all(carts.map((c) => quoteOk(c, { discount_code: "cuoi1" })));
        for (const q of quotes) {
          expect(q.discount_code).toBe("CUOI1");
          expect(q.discount_total).toBeGreaterThan(0);
        }

        const results = await Promise.all(quotes.map((q) => submit(submitBody(q))));

        const ok = results.filter((r) => r.status === 200);
        expect(ok).toHaveLength(1);
        const rejected = results.filter((r) => r.status !== 200);
        expect(rejected).toHaveLength(19);
        for (const r of rejected) expect(r.data).toMatchObject({ status: 409, code: "DISCOUNT_EXHAUSTED" });
        const usage = await service().listCouponUsages({ promotion_code: "CUOI1" });
        expect(usage.filter((u) => u.state === "held")).toHaveLength(1);
        expect(usage.find((u) => u.state === "held")!.order_id).toBe(ok[0]!.data.order.id);
        expect(await countOrders(container)).toBe(1);
        // Lượt đã hết → báo giá mới cũng báo DISCOUNT_EXHAUSTED.
        const late = await quote(carts[0]!, { discount_code: "CUOI1" });
        expect(late.status).toBe(409);
        expect(late.data.code).toBe("DISCOUNT_EXHAUSTED");
      });
    });

    describe("bù trừ khi lỗi giữa chừng", () => {
      it("lỗi sau khi đã tạo đơn + reservation + payment attempt → xoá đơn/reservation, nhả mã, attempt failed", async () => {
        await createPromotion(container, "BUTRU", { limit: 5, percent: 10 });
        const cartId = await createCart([["Đen/M", 2]]);
        const q = await quoteOk(cartId, { payment_method: "vnpay", discount_code: "BUTRU" });
        failBeforeFinalize.add(cartId);
        try {
          const res = await submit(submitBody(q));
          expect(res.status).toBe(500);
          expect(res.data.code).toBe("INTERNAL");
          expect(await countOrders(container)).toBe(0);
          expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
          expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });
          expect(await service().listOrderFinances({ cart_id: cartId })).toHaveLength(0);
          const usage = await service().listCouponUsages({ promotion_code: "BUTRU" });
          expect(usage.map((u) => u.state)).toEqual(["released"]);
          expect(await service().countCountedCouponUsage("BUTRU")).toBe(0);
          const payments = await service().listPaymentAttempts({});
          expect(payments.map((p) => p.state)).toEqual(["failed"]);
          const attempts = await service().listCheckoutAttempts({ cart_id: cartId });
          expect(attempts.map((a) => [a.state, a.error_code])).toEqual([["failed", "INTERNAL"]]);
          expect(
            await leakedLocks([
              `cart:${cartId}`,
              `inventory_item:${fx.variants["Đen/M"]!.inventoryItemId}`,
              "promotion:BUTRU",
            ]),
          ).toEqual([]);
        } finally {
          failBeforeFinalize.delete(cartId);
        }
        // Phiên bản giỏ được nhả: đặt lại (key mới) thành công.
        const retry = await submit(submitBody(q));
        expect(retry.status).toBe(200);
        expect(await countOrders(container)).toBe(1);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 2 });
      });
    });

    describe("quyền sở hữu giỏ", () => {
      /**
       * Khách có tài khoản. Đăng ký khách qua HTTP đóng ở P0 (T-138: identity emailpass dùng chung mọi actor → đăng ký khách
       * dò/chiếm được email admin) → tạo identity + customer trong tiến trình, đăng nhập qua route thật.
       */
      async function registerCustomer(email: string): Promise<string> {
        const password = "MatKhau-ThuNghiem-123";
        const reg = await container
          .resolve(Modules.AUTH)
          .register("emailpass", { body: { email, password } });
        expect(reg.success).toBe(true);
        await createCustomerAccountWorkflow(container).run({
          input: { authIdentityId: reg.authIdentity!.id, customerData: { email, first_name: "Khách" } },
        });
        const login = await api.post("/auth/customer/emailpass", { email, password }, cfg());
        expect(login.status).toBe(200);
        return login.data.token as string;
      }

      it("[api1-bola post /store/x/checkout/quote, post /store/x/checkout/submit, get /store/x/checkout/attempts/{id}, post /store/x/checkout/attempts/{id}/recheck] giỏ của người khác → 404 (vãng lai, khách khác, kênh bán khác); chủ giỏ → được phép", async () => {
        const tokenA = await registerCustomer(`a-${randomUUID()}@example.test`);
        const tokenB = await registerCustomer(`b-${randomUUID()}@example.test`);
        const cartA = await createCart([["Đen/S", 1]], tokenA);

        const anon = await quote(cartA);
        expect(anon.status).toBe(404);
        expect(anon.data.code).toBe("NOT_FOUND");
        const other = await quote(cartA, {}, tokenB);
        expect(other.status).toBe(404);
        const unknown = await quote("cart_khong_ton_tai");
        expect(unknown.status).toBe(404);
        // Giống hệt trừ `trace_id` (mã ngẫu nhiên theo request, T-088) — không phân biệt giỏ có/không tồn tại.
        expect({ ...unknown.data, trace_id: "*" }).toEqual({ ...anon.data, trace_id: "*" });
        expect(unknown.data.trace_id).not.toBe(anon.data.trace_id);

        const q = await quoteOk(cartA, {}, tokenA);
        expect((await submit(submitBody(q))).status).toBe(404);
        expect((await submit(submitBody(q), newKey(), tokenB)).status).toBe(404);
        const mine = await submit(submitBody(q), newKey(), tokenA);
        expect(mine.status).toBe(200);
        const order = await container.resolve(Modules.ORDER).retrieveOrder(mine.data.order.id);
        expect(order.customer_id).toBeTruthy();

        const statusB = await api.get(
          `/store/x/checkout/attempts/${mine.data.checkout_attempt_id}?cart_id=${cartA}`,
          cfg({ authorization: `Bearer ${tokenB}` }),
        );
        expect(statusB.status).toBe(404);
        // Recheck bằng khách khác hoặc vãng lai → 404 như attempt không tồn tại (không dò được, không tốn lượt giới hạn).
        for (const auth of [{ authorization: `Bearer ${tokenB}` }, {}] as Array<Record<string, string>>) {
          const recheckForeign = await api.post(
            `/store/x/checkout/attempts/${mine.data.checkout_attempt_id}/recheck?cart_id=${cartA}`,
            {},
            cfg(auth),
          );
          expect(recheckForeign.status).toBe(404);
        }

        // Publishable key của kênh bán khác không thấy giỏ của kênh này.
        const { result: channels } = await (
          await import("@medusajs/medusa/core-flows")
        )
          .createSalesChannelsWorkflow(container)
          .run({ input: { salesChannelsData: [{ name: "Kênh khác" }] } });
        const { result: keys } = await (
          await import("@medusajs/medusa/core-flows")
        )
          .createApiKeysWorkflow(container)
          .run({
            input: { api_keys: [{ title: "Khác", type: "publishable", created_by: "" }] },
          });
        await (
          await import("@medusajs/medusa/core-flows")
        )
          .linkSalesChannelsToApiKeyWorkflow(container)
          .run({ input: { id: keys[0]!.id, add: [channels[0]!.id] } });
        const guestCart = await createCart([["Trắng/S", 1]]);
        const foreign = await api.post(
          "/store/x/checkout/quote",
          { cart_id: guestCart, payment_method: "cod", address: HANOI_ADDRESS },
          { headers: { "x-publishable-api-key": keys[0]!.token }, validateStatus: () => true },
        );
        expect(foreign.status).toBe(404);
      });

      it("đường tạo đơn native POST /store/carts/:id/complete bị chặn", async () => {
        const cartId = await createCart([["Đen/S", 1]]);
        const res = await api.post(`/store/carts/${cartId}/complete`, {}, cfg());
        expect(res.status).toBe(404);
        expect(res.data.replacement).toBe("/store/x/checkout/submit");
        expect(await countOrders(container)).toBe(0);
      });
    });
  },
});
