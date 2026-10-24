import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { createOrderWorkflow, createReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import {
  codConfirmTimeout,
  dispatchOutbox,
  expireHolds,
  OUTBOX_POLICY,
  outboxBackoffMs,
  reconcileAttempts,
} from "../../src/lib/checkout/jobs";
import {
  HttpVnpayGateway,
  setVnpayGatewayForTest,
  type QueryStatusResult,
  type VnpayGateway,
} from "../../src/lib/checkout/vnpay-gateway";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { checkoutClient, DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import {
  createPromotion,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

const R = vnpay.IPN_RESPONSES;
const MIN = 60_000;

/** Gateway lập trình được: kết quả querydr theo txnRef (mặc định "chưa trả"). */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  calls = 0;
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    this.calls += 1;
    return (
      this.results.get(input.txnRef) ?? { outcome: "not_paid", transactionNo: null, reason: "status_01" }
    );
  }
}

/** PRNG có seed (mulberry32) — thứ tự ngẫu nhiên lặp lại được. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let gateway: ScriptedGateway;
    const client = checkoutClient(api, () => fx);
    /** Ký IPN như VNPAY (độc lập với gateway querydr của app). */
    const signer = new vnpay.MockVnpayGateway(DEV_VNPAY);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    // Job nền của app chạy theo giờ thật; test gọi hàm xử lý với `now` ở TƯƠNG LAI nên job nền không chạm dữ liệu test.
    const future = (ms: number) => new Date(Date.now() + ms);

    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 50, "Đen/M": 50, "Trắng/S": 50, "Trắng/M": 50 },
      });
      gateway = new ScriptedGateway();
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => setVnpayGatewayForTest(null));

    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const nativeStatus = async (orderId: string) =>
      (await container.resolve(Modules.ORDER).retrieveOrder(orderId)).status;

    describe("expire-holds", () => {
      it("S-005: hết hạn + chưa trả → hủy native, nhả reservation, mã released, attempt failed; 2 lượt song song chỉ hủy 1 lần", async () => {
        await createPromotion(container, "HETHAN", { limit: 5, percent: 10 });
        const o = await client.placeOrder([["Đen/M", 2]], "vnpay", { discount_code: "HETHAN" });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 2 });

        // Chưa tới hạn → không làm gì.
        expect((await expireHolds(container, { now: future(14 * MIN) })).cancelled).toEqual([]);

        const [a, b] = await Promise.all([
          expireHolds(container, { now: future(16 * MIN) }),
          expireHolds(container, { now: future(16 * MIN) }),
        ]);
        expect([...a.cancelled, ...b.cancelled]).toEqual([o.orderId]);
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect(await nativeStatus(o.orderId)).toBe("canceled");
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
        expect((await service().listCouponUsages({ promotion_code: "HETHAN" })).map((u) => u.state)).toEqual([
          "released",
        ]);
        const [attempt] = await service().listCheckoutAttempts({ id: o.attemptId });
        expect(attempt).toMatchObject({ state: "failed", error_code: "HOLD_EXPIRED" });
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        expect(pa!.state).toBe("failed");
        const cancelledEvents = (await service().listOutboxEvents({ aggregate_id: o.orderId })).filter(
          (e) => e.type === "order.cancelled",
        );
        expect(cancelledEvents).toHaveLength(1);

        // Chạy lại → không làm gì thêm.
        expect(await expireHolds(container, { now: future(20 * MIN) })).toMatchObject({ cancelled: [] });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
      });

      it("AT09: hủy do hết hạn rồi IPN paid tới → ghi capture + late_payment, đơn vẫn cancelled", async () => {
        const o = await client.placeOrder([["Trắng/S", 1]], "vnpay");
        expect((await expireHolds(container, { now: future(16 * MIN) })).cancelled).toEqual([o.orderId]);
        expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).data).toEqual(R.success);
        expect((await fin(o.orderId)).state).toBe("cancelled");
        expect((await service().listPaymentLedgers({ order_id: o.orderId })).map((l) => l.amount)).toEqual([
          o.total,
        ]);
        const late = await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" });
        expect(late.map((e) => e.amount)).toEqual([o.total]);
        expect(await nativeStatus(o.orderId)).toBe("canceled");
      });

      it("hết hạn nhưng querydr báo đã trả → xác nhận như IPN (không hủy)", async () => {
        const o = await client.placeOrder([["Trắng/M", 1]], "vnpay");
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        gateway.results.set(pa!.txn_ref, { outcome: "paid", transactionNo: "14999001", reason: "status_00" });
        expect((await expireHolds(container, { now: future(16 * MIN) })).confirmed).toEqual([o.orderId]);
        expect((await fin(o.orderId)).state).toBe("confirmed");
        expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(1);
      });

      it("AT11: querydr treo quá hạn (HTTP thật) → unknown: không hủy, không tạo attempt mới, ngoại lệ payment_unknown hạn 30 phút", async () => {
        const hanging = createServer(() => undefined);
        await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", () => r()));
        const url = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/api`;
        setVnpayGatewayForTest(new HttpVnpayGateway({ ...DEV_VNPAY, apiUrl: url }, 200));
        try {
          const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
          const now = future(16 * MIN);
          for (let i = 0; i < 2; i++) {
            expect((await expireHolds(container, { now })).unknown).toEqual([o.orderId]);
          }
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          expect(await nativeStatus(o.orderId)).not.toBe("canceled");
          expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
          const attempts = await service().listPaymentAttempts({ order_id: o.orderId });
          expect(attempts.map((p) => p.state)).toEqual(["unknown"]);
          const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
          expect(ex).toHaveLength(1);
          expect(ex[0]!.detail).toMatchObject({ reason: "timeout" });
          expect(new Date(ex[0]!.due_at!).getTime() - now.getTime()).toBe(30 * MIN);
          // Giao dịch sau đó được VNPAY báo đã trả (IPN) → vẫn xác nhận được.
          expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).data).toEqual(R.success);
          expect((await fin(o.orderId)).state).toBe("confirmed");
        } finally {
          await new Promise<void>((r) => hanging.close(() => r()));
          setVnpayGatewayForTest(gateway);
        }
      });

      it("AT12: expiry ∥ IPN paid ×20 lượt, thứ tự ngẫu nhiên có seed → mỗi đơn đúng một kết cục, ledger luôn có tiền", async () => {
        const random = rng(20261024);
        const outcomes: string[] = [];
        for (let round = 0; round < 20; round++) {
          const key = Object.keys(fx.variants)[round % 4]!;
          const o = await client.placeOrder([[key, 1]], "vnpay");
          const params = signer.pay(o.paymentUrl, "success");
          const [d1, d2] = [Math.floor(random() * 25), Math.floor(random() * 25)];
          const [ipnRes] = await Promise.all([
            sleep(d1).then(() => ipn(api, params)),
            sleep(d2).then(() => expireHolds(container, { now: future(16 * MIN) })),
          ]);
          expect(ipnRes.data).toEqual(R.success);
          const f = await fin(o.orderId);
          outcomes.push(f.state);
          expect(["confirmed", "cancelled"]).toContain(f.state);
          const ledger = await service().listPaymentLedgers({ order_id: o.orderId });
          expect(ledger.map((l) => [l.kind, l.amount])).toEqual([["capture", o.total]]);
          const late = await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" });
          const reservations = (await reservationsOf(container, fx, key)).filter((r) =>
            String(r.description).includes(o.attemptId),
          );
          if (f.state === "cancelled") {
            expect(late).toHaveLength(1);
            expect(await nativeStatus(o.orderId)).toBe("canceled");
            expect(reservations).toHaveLength(0);
          } else {
            expect(late).toHaveLength(0);
            expect(await nativeStatus(o.orderId)).not.toBe("canceled");
            expect(reservations).toHaveLength(1);
          }
          const confirmedEvents = (await service().listOutboxEvents({ aggregate_id: o.orderId })).filter(
            (e) => e.type === "order.confirmed" || e.type === "order.cancelled",
          );
          expect(confirmedEvents).toHaveLength(1);
        }
        // Tồn khớp tuyệt đối: reserved = số đơn confirmed của biến thể đó.
        for (const [i, key] of Object.keys(fx.variants).entries()) {
          const confirmed = outcomes.filter((s, r) => r % 4 === i && s === "confirmed").length;
          expect(await inventoryLevel(container, fx, key)).toEqual({ stocked: 50, reserved: confirmed });
        }
        process.stderr.write(`AT12 kết cục: ${JSON.stringify(outcomes)}\n`);
      });
    });

    describe("reconcile-attempts (AT10)", () => {
      it("attempt preparing có 1/2 reservation, lease quá hạn → bù trừ hết, tồn về đúng; 2 lượt song song chỉ bù 1 lần", async () => {
        await createPromotion(container, "DOI", { limit: 3, percent: 10 });
        const cartId = await client.createCart([
          ["Đen/S", 1],
          ["Trắng/S", 2],
        ]);
        const q = await client.quote(cartId, { discount_code: "DOI" });
        const s = service();
        // Dựng đúng trạng thái "tiến trình chết giữa bước 8": attempt preparing, mã held, đơn native, 1/2 reservation.
        const attemptId = (await s.insertAttemptIfAbsent({
          cart_id: cartId,
          cart_version: q.cart_version,
          idempotency_scope: `checkout.submit:cart:${cartId}`,
          idempotency_key: "k-reconcile-0000000001",
          payload_hash: "h",
          quote_id: q.id,
          payment_method: "cod",
          lease_until: new Date(Date.now() + 2 * MIN),
        }))!;
        await s.holdCoupon({ promotion_code: "DOI", promotion_id: null, attempt_id: attemptId });
        const { result: order } = await createOrderWorkflow(container).run({
          input: {
            region_id: fx.regionId,
            sales_channel_id: fx.salesChannelId,
            currency_code: "vnd",
            status: "pending",
            items: [
              {
                variant_id: fx.variants["Đen/S"]!.id,
                title: "Đen/S",
                quantity: 1,
                unit_price: 700_000,
                is_tax_inclusive: true,
              },
              {
                variant_id: fx.variants["Trắng/S"]!.id,
                title: "Trắng/S",
                quantity: 2,
                unit_price: 300_000,
                is_tax_inclusive: true,
              },
            ],
            metadata: { x_checkout_attempt_id: attemptId },
          },
        });
        const full = await container.resolve(Modules.ORDER).retrieveOrder(order.id, { relations: ["items"] });
        const blackLine = full.items!.find((i) => i.variant_id === fx.variants["Đen/S"]!.id)!;
        await createReservationsWorkflow(container).run({
          input: {
            reservations: [
              {
                inventory_item_id: fx.variants["Đen/S"]!.inventoryItemId,
                location_id: fx.sellableLocationId,
                quantity: 1,
                line_item_id: blackLine.id,
              },
            ],
          },
        });
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 1 });

        // Lease chưa hết → không động vào (submit có thể còn sống).
        expect((await reconcileAttempts(container, { now: future(1 * MIN) })).compensated).toEqual([]);

        const [r1, r2] = await Promise.all([
          reconcileAttempts(container, { now: future(3 * MIN) }),
          reconcileAttempts(container, { now: future(3 * MIN) }),
        ]);
        expect([...r1.compensated, ...r2.compensated]).toEqual([attemptId]);
        const [att] = await s.listCheckoutAttempts({ id: attemptId });
        expect(att).toMatchObject({ state: "compensated", error_code: "LEASE_EXPIRED" });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 0 });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 50, reserved: 0 });
        expect(await nativeStatus(order.id)).toBe("canceled");
        expect(await s.countCountedCouponUsage("DOI")).toBe(0);
        expect((await reconcileAttempts(container, { now: future(5 * MIN) })).compensated).toEqual([]);

        // Phiên bản giỏ đã được nhả: khách đặt lại được (quote mới, key mới).
        const res = await client.submit(await client.quote(cartId, { discount_code: "DOI" }));
        expect(res.status).toBe(200);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 1 });
      });
    });

    describe("cod-confirm-timeout", () => {
      it("đơn COD quá 24 giờ chưa xác nhận → một ngoại lệ cho nhân viên đơn, không tự hủy", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "cod");
        expect((await codConfirmTimeout(container, { now: future(23 * 60 * MIN) })).opened).toEqual([]);
        expect((await codConfirmTimeout(container, { now: future(25 * 60 * MIN) })).opened).toEqual([
          o.orderId,
        ]);
        expect((await codConfirmTimeout(container, { now: future(26 * 60 * MIN) })).opened).toEqual([]);
        const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "cod_confirm_overdue" });
        expect(ex).toHaveLength(1);
        expect((await fin(o.orderId)).state).toBe("placed");
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
      });
    });

    describe("outbox-dispatch", () => {
      it("lỗi gửi → thử lại lũy thừa; quá số lần → dead + ngoại lệ; hai dispatcher song song không gửi trùng", async () => {
        const s = service();
        const base = future(60 * MIN);
        // Hạn đầu ở tương lai → dispatcher nền (giờ thật) không nhận sự kiện của test.
        await s.insertOutbox("test.fail:1", "agg_1", "test.fail", {}, undefined, base);
        const failing = { "test.fail": async () => Promise.reject(new Error("SMTP 503")) };

        let now = base;
        for (let attempt = 1; attempt < OUTBOX_POLICY.maxAttempts; attempt++) {
          expect((await dispatchOutbox(container, { now, handlers: failing })).retried).toEqual([
            "test.fail:1",
          ]);
          // Chưa tới hạn thử lại → không nhận.
          expect((await dispatchOutbox(container, { now, handlers: failing })).retried).toEqual([]);
          const [ev] = await s.listOutboxEvents({ event_key: "test.fail:1" });
          expect(ev).toMatchObject({ state: "failed", attempts: attempt, last_error: "SMTP 503" });
          expect(new Date(ev!.next_attempt_at).getTime() - now.getTime()).toBe(outboxBackoffMs(attempt));
          now = new Date(ev!.next_attempt_at);
        }
        expect((await dispatchOutbox(container, { now, handlers: failing })).dead).toEqual(["test.fail:1"]);
        const [dead] = await s.listOutboxEvents({ event_key: "test.fail:1" });
        expect(dead).toMatchObject({ state: "dead", attempts: OUTBOX_POLICY.maxAttempts });
        expect(await s.listOpsExceptions({ kind: "outbox_dead" })).toHaveLength(1);

        for (let i = 0; i < 6; i++) {
          await s.insertOutbox(`test.count:${i}`, "agg_2", "test.count", { i }, undefined, base);
        }
        const seen: string[] = [];
        const counting = {
          "test.count": async (_c: unknown, e: { event_key: string }) => {
            seen.push(e.event_key);
            await sleep(20);
          },
        };
        const later = future(61 * MIN);
        await Promise.all([
          dispatchOutbox(container, { now: later, handlers: counting }),
          dispatchOutbox(container, { now: later, handlers: counting }),
        ]);
        expect(seen.sort()).toEqual(Array.from({ length: 6 }, (_, i) => `test.count:${i}`));
        const sent = await s.listOutboxEvents({ aggregate_id: "agg_2" });
        expect(sent.every((e) => e.state === "sent" && e.attempts === 0)).toBe(true);
      });
    });
  },
});
