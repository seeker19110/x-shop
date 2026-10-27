import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { createOrderWorkflow, createReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import {
  codConfirmTimeout,
  dispatchOutbox,
  expireHolds,
  isTransientQueryFailure,
  OUTBOX_POLICY,
  outboxBackoffMs,
  probeOrder,
  reconcileAttempts,
  rotate,
} from "../../src/lib/checkout/jobs";
import {
  OUTBOX_BREAKER_POLICY,
  VNPAY_QUERYDR_BREAKER_KEY,
  type OutboxBreakerPolicy,
} from "../../src/lib/outbox/breaker";
import {
  HttpVnpayGateway,
  setVnpayGatewayForTest,
  type QueryStatusResult,
  type VnpayGateway,
} from "../../src/lib/checkout/vnpay-gateway";
import { HOLD_RECHECK_POLICY } from "../../src/lib/checkout/hold-recheck";
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
/** Dung sai lịch kiểm lại (T-164): mốc hẹn = now + delay − SLACK. */
const SLACK = HOLD_RECHECK_POLICY.slackMs;

/** Gateway lập trình được: kết quả querydr theo txnRef (mặc định "chưa trả"); `down` → lỗi mạng (lỗi tạm của cổng). */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  calls = 0;
  /** txnRef của từng lời gọi (đếm theo đơn của test — không lẫn lời gọi của job nền nếu có). */
  readonly seen: string[] = [];
  down = false;
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    this.calls += 1;
    this.seen.push(input.txnRef);
    if (this.down) return { outcome: "unknown", transactionNo: null, reason: "network" };
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
          expect((await expireHolds(container, { now })).unknown).toEqual([o.orderId]);
          // T-164: cùng thời điểm → đang backoff, không hỏi lại; tới hạn kiểm lại (1 phút) → hỏi lại, vẫn unknown.
          expect(await expireHolds(container, { now })).toMatchObject({ unknown: [], skipped: [] });
          expect(new Date((await fin(o.orderId)).next_check_at!).getTime()).toBe(now.getTime() + MIN - SLACK);
          expect((await expireHolds(container, { now: new Date(now.getTime() + MIN) })).unknown).toEqual([
            o.orderId,
          ]);
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

    describe("expire-holds — circuit breaker querydr (T-161)", () => {
      const KEY = VNPAY_QUERYDR_BREAKER_KEY;
      const POLICY: OutboxBreakerPolicy = {
        ...OUTBOX_BREAKER_POLICY,
        failureThreshold: 2,
        cooldownMs: 5 * MIN,
      };
      const pg = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      const reset = async () => {
        await pg().raw(`DELETE FROM job_breaker WHERE breaker_key = ?`, [KEY]);
        await pg().raw(`DELETE FROM rate_limit_counter WHERE bucket = ?`, [`breaker.budget:${KEY}`]);
        await pg().raw(
          `UPDATE ops_exception SET state = 'resolved' WHERE kind = 'job_circuit_open' AND detail->>'breaker' = ?`,
          [KEY],
        );
      };
      beforeEach(reset);
      afterEach(async () => {
        gateway.down = false;
        await reset();
      });
      const breakerRow = async () =>
        (
          (
            await pg().raw(`SELECT state, trip_count, open_until FROM job_breaker WHERE breaker_key = ?`, [
              KEY,
            ])
          ).rows as Array<{ state: string; trip_count: number; open_until: Date | null }>
        )[0];
      const circuitExceptions = async () =>
        (
          await pg().raw(
            `SELECT detail FROM ops_exception WHERE kind = 'job_circuit_open' AND state <> 'resolved' AND detail->>'breaker' = ?`,
            [KEY],
          )
        ).rows as Array<{ detail: Record<string, unknown> }>;
      const txnOf = async (orderId: string) =>
        (await service().listPaymentAttempts({ order_id: orderId }, { order: { created_at: "ASC" } }))[0]!
          .txn_ref;
      const VARIANTS = ["Đen/S", "Đen/M", "Trắng/S", "Trắng/M"] as const;
      /** 4 đơn VNPAY, mỗi biến thể 1 (thứ tự hết hạn = thứ tự đặt). */
      const placeFour = async () => {
        const out = [];
        for (const v of VARIANTS) {
          const o = await client.placeOrder([[v, 1]], "vnpay");
          out.push({ ...o, variant: v, txn: await txnOf(o.orderId) });
        }
        return out;
      };
      const callsFor = (txns: string[]) => gateway.seen.filter((t) => txns.includes(t)).length;
      const reserved = async (variant: string) => (await inventoryLevel(container, fx, variant)).reserved;

      it("breaker mở → không gọi querydr, giữ hàng như unknown (không hủy đơn đã trả); đóng lại → xử lý đúng", async () => {
        const orders = await placeFour();
        const [o1, o2, o3, o4] = orders;
        const txns = orders.map((o) => o.txn);
        const ids = orders.map((o) => o.orderId);
        const t0 = future(16 * MIN);

        // VNPAY không phản hồi: 2 đơn khác nhau lỗi tạm → mở; 2 đơn còn lại KHÔNG gọi querydr.
        gateway.down = true;
        const r1 = await expireHolds(container, { now: t0, breakerPolicy: POLICY });
        expect(callsFor(txns)).toBe(2);
        expect(r1).toMatchObject({
          unknown: [o1!.orderId, o2!.orderId],
          deferred: [o3!.orderId, o4!.orderId],
        });
        expect(r1.cancelled).toEqual([]);
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 1 });
        const trips = await circuitExceptions();
        expect(trips).toHaveLength(1);
        expect(trips[0]!.detail).toMatchObject({ breaker: KEY, reason: "consecutive_failures" });
        for (const o of orders) {
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          expect(await reserved(o.variant)).toBe(1);
          const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
          expect(pa!.state).toBe("unknown");
        }
        // Đơn bị hoãn vẫn có người theo dõi (không giữ hàng âm thầm): payment_unknown hạn 30 phút, lý do breaker_open.
        for (const o of [o3!, o4!]) {
          const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
          expect(ex).toHaveLength(1);
          expect(ex[0]!.detail).toMatchObject({ reason: "breaker_open", source: "expire-holds" });
          expect(new Date(ex[0]!.due_at!).getTime() - t0.getTime()).toBe(30 * MIN);
        }

        // Trong thời gian nguội: VNPAY thật ra đã thu tiền o2 (IPN lạc) — vẫn KHÔNG gọi, KHÔNG hủy, KHÔNG nhả.
        gateway.results.set(o2!.txn, { outcome: "paid", transactionNo: "14999161", reason: "status_00" });
        const r2 = await expireHolds(container, {
          now: new Date(t0.getTime() + 2 * MIN),
          breakerPolicy: POLICY,
        });
        expect(callsFor(txns)).toBe(2);
        expect([...r2.deferred].sort()).toEqual([...ids].sort());
        expect(r2.cancelled).toEqual([]);
        expect(await reserved(o2!.variant)).toBe(1);
        // IPN đi đường riêng (không qua breaker) → o3 xác nhận ngay dù breaker mở.
        expect((await ipn(api, signer.pay(o3!.paymentUrl, "success"))).data).toEqual(R.success);
        expect((await fin(o3!.orderId)).state).toBe("confirmed");

        // Hết nguội, cổng vẫn hỏng: đúng MỘT lượt thử → lỗi → mở thêm một kỳ; không hủy gì.
        const t1 = new Date(t0.getTime() + 5 * MIN);
        const r3 = await expireHolds(container, { now: t1, breakerPolicy: POLICY });
        expect(callsFor(txns)).toBe(3);
        expect(r3.cancelled).toEqual([]);
        expect(r3.unknown).toHaveLength(1);
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 2 });
        expect(await circuitExceptions()).toHaveLength(1);

        // Cổng hồi phục, hết kỳ nguội thứ hai → lượt thử thành công → đóng → mọi đơn còn chờ được xử lý đúng.
        gateway.down = false;
        const r4 = await expireHolds(container, {
          now: new Date(t0.getTime() + 10 * MIN),
          breakerPolicy: POLICY,
        });
        expect(r4.deferred).toEqual([]);
        expect(r4.confirmed).toEqual([o2!.orderId]);
        expect([...r4.cancelled].sort()).toEqual([o1!.orderId, o4!.orderId].sort());
        expect(await breakerRow()).toMatchObject({ state: "closed" });
        expect((await fin(o1!.orderId)).state).toBe("cancelled");
        expect((await fin(o2!.orderId)).state).toBe("confirmed");
        expect((await fin(o3!.orderId)).state).toBe("confirmed");
        expect((await fin(o4!.orderId)).state).toBe("cancelled");
        expect(await reserved(o1!.variant)).toBe(0);
        expect(await reserved(o2!.variant)).toBe(1);
        expect(await reserved(o3!.variant)).toBe(1);
        expect(await reserved(o4!.variant)).toBe(0);
        // o3: hoãn suốt lúc breaker mở, xác nhận qua IPN trước khi đóng → chưa từng tốn lượt querydr.
        expect(gateway.seen.filter((t) => t === o3!.txn)).toHaveLength(0);
      });

      it("hai lượt song song khi cổng hỏng: mở đúng một lần, lượt gọi ≤ ngưỡng + số lượt; sau đó song song khi hồi phục → mỗi đơn đúng một kết cục", async () => {
        const orders = await placeFour();
        const txns = orders.map((o) => o.txn);
        const t0 = future(16 * MIN);
        gateway.down = true;
        const [a, b] = await Promise.all([
          expireHolds(container, { now: t0, breakerPolicy: POLICY }),
          expireHolds(container, { now: t0, breakerPolicy: POLICY }),
        ]);
        expect(callsFor(txns)).toBeGreaterThanOrEqual(POLICY.failureThreshold);
        expect(callsFor(txns)).toBeLessThanOrEqual(POLICY.failureThreshold + 2);
        expect([...a.cancelled, ...b.cancelled]).toEqual([]);
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 1 });
        expect(await circuitExceptions()).toHaveLength(1);
        for (const o of orders) {
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          expect(await reserved(o.variant)).toBe(1);
        }

        gateway.down = false;
        const t1 = new Date(t0.getTime() + 5 * MIN);
        const [c, d] = await Promise.all([
          expireHolds(container, { now: t1, breakerPolicy: POLICY }),
          expireHolds(container, { now: t1, breakerPolicy: POLICY }),
        ]);
        // Bản thua lượt thử half-open có thể hoãn vài đơn — lượt kế tiếp xử lý nốt.
        const e = await expireHolds(container, { now: new Date(t1.getTime() + MIN), breakerPolicy: POLICY });
        const cancelled = [...c.cancelled, ...d.cancelled, ...e.cancelled].sort();
        expect(cancelled).toEqual(orders.map((o) => o.orderId).sort());
        expect(await breakerRow()).toMatchObject({ state: "closed" });
        for (const o of orders) {
          expect((await fin(o.orderId)).state).toBe("cancelled");
          expect(await reserved(o.variant)).toBe(0);
          const events = (await service().listOutboxEvents({ aggregate_id: o.orderId })).filter(
            (x) => x.type === "order.cancelled",
          );
          expect(events).toHaveLength(1);
        }
      });

      it("isTransientQueryFailure: chỉ lỗi tạm của cổng mở breaker; cổng đã trả lời thì không", () => {
        for (const r of [
          "timeout",
          "network",
          "adapter_error:boom",
          "http_500",
          "http_503",
          "http_408",
          "http_429",
        ]) {
          expect(isTransientQueryFailure(r)).toBe(true);
        }
        for (const r of [
          // Chuỗi thật của vnpay.interpretQueryResponse (packages/domain/src/providers/vnpay/vnpay.ts).
          "status_01",
          "status_00",
          "invalid_signature",
          "mismatch",
          "amount_mismatch",
          "response_91",
          "http_400",
          "http_401",
          "http_403",
          "http_404",
          "",
          "http_5000",
        ]) {
          expect(isTransientQueryFailure(r)).toBe(false);
        }
      });

      it("cổng trả lời 401/403/chữ ký sai/400 → không mở breaker, không hoãn, không hủy (unknown)", async () => {
        const orders = await placeFour();
        const reasons = ["http_401", "http_403", "invalid_signature", "http_400"];
        orders.forEach((o, i) =>
          gateway.results.set(o.txn, { outcome: "unknown", transactionNo: null, reason: reasons[i]! }),
        );
        const r = await expireHolds(container, { now: future(16 * MIN), breakerPolicy: POLICY });
        expect(callsFor(orders.map((o) => o.txn))).toBe(4);
        expect(r.deferred).toEqual([]);
        expect(r.cancelled).toEqual([]);
        expect(r.unknown).toHaveLength(4);
        expect((await breakerRow())?.state ?? "closed").toBe("closed");
      });

      it("lượt thử half-open xoay vòng: đơn cũ nhất lỗi tạm ổn định không giữ breaker mở — đơn khác xử lý, đơn lỗi vẫn được hỏi lại", async () => {
        // Review T-161 🟠: trước sửa, lượt thử luôn rơi vào o1 (ORDER BY hold_expires_at) → mở lại mãi, o2..o4 giữ hàng vô hạn.
        const orders = await placeFour();
        const [o1, o2, o3, o4] = orders;
        const t0 = future(16 * MIN);
        gateway.down = true;
        await expireHolds(container, { now: t0, breakerPolicy: POLICY });
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 1 });
        gateway.down = false;
        gateway.results.set(o1!.txn, { outcome: "unknown", transactionNo: null, reason: "http_500" });
        const o1Calls = () => gateway.seen.filter((t) => t === o1!.txn).length;
        const before = o1Calls();
        const r1 = await expireHolds(container, {
          now: new Date(t0.getTime() + 5 * MIN),
          breakerPolicy: POLICY,
        });
        expect([...r1.cancelled].sort()).toEqual([o2!.orderId, o3!.orderId, o4!.orderId].sort());
        expect(r1.unknown).toEqual([o1!.orderId]);
        expect(await breakerRow()).toMatchObject({ state: "closed", trip_count: 1 });
        for (const o of [o2!, o3!, o4!]) {
          expect((await fin(o.orderId)).state).toBe("cancelled");
          expect(await reserved(o.variant)).toBe(0);
        }
        // o1 không bị bỏ quên: hỏi ngay trong lượt đó và mỗi lần tới hạn kiểm lại (backoff T-164); một đơn lỗi lặp chỉ
        // tính một → breaker vẫn đóng.
        expect(o1Calls()).toBe(before + 1);
        const o1Due = async () => new Date((await fin(o1!.orderId)).next_check_at!);
        for (let k = 2; k <= 4; k++) {
          const r = await expireHolds(container, { now: await o1Due(), breakerPolicy: POLICY });
          expect(r.unknown).toEqual([o1!.orderId]);
        }
        expect(o1Calls()).toBe(before + 4);
        expect(await breakerRow()).toMatchObject({ state: "closed", trip_count: 1 });
        expect((await fin(o1!.orderId)).state).toBe("awaiting_payment");
        expect(await reserved(o1!.variant)).toBe(1);
        // VNPAY hồi đáp cho o1 → hủy đúng.
        gateway.results.delete(o1!.txn);
        const r5 = await expireHolds(container, { now: await o1Due(), breakerPolicy: POLICY });
        expect(r5.cancelled).toEqual([o1!.orderId]);
      });

      it("cổng vẫn hỏng, số đơn không đổi → lượt thử xoay qua đủ mọi đơn và không bao giờ thử lại ngay đơn vừa lỗi", async () => {
        const orders = await placeFour();
        const t0 = future(16 * MIN);
        gateway.down = true;
        await expireHolds(container, { now: t0, breakerPolicy: POLICY }); // o1, o2 lỗi → mở (trip_count 1)
        const probes: string[] = [];
        for (let k = 1; k <= 4; k++) {
          const n = gateway.seen.length;
          await expireHolds(container, { now: new Date(t0.getTime() + k * 5 * MIN), breakerPolicy: POLICY });
          expect(gateway.seen.length - n).toBe(1); // đúng một lượt thử mỗi kỳ
          probes.push(gateway.seen[gateway.seen.length - 1]!);
        }
        expect(new Set(probes).size).toBe(4); // xoay hết 4 đơn
        for (let i = 1; i < probes.length; i++) expect(probes[i]).not.toBe(probes[i - 1]);
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 5 });
        for (const o of orders) expect((await fin(o.orderId)).state).toBe("awaiting_payment");
      });

      it("hoãn lặp lại nhiều lượt → mỗi đơn đúng MỘT payment_unknown (idempotent)", async () => {
        const orders = await placeFour();
        const t0 = future(16 * MIN);
        gateway.down = true;
        for (let k = 0; k < 4; k++) {
          await expireHolds(container, { now: new Date(t0.getTime() + k * MIN), breakerPolicy: POLICY });
        }
        expect(callsFor(orders.map((o) => o.txn))).toBe(2);
        for (const [i, o] of orders.entries()) {
          const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
          expect(ex).toHaveLength(1);
          expect(ex[0]!.detail).toMatchObject({ reason: i < 2 ? "network" : "breaker_open" });
        }
      });

      it("bóp ngân sách → hoãn với lý do thật `breaker_throttled` (không gán cứng breaker_open), không hủy", async () => {
        const orders = await placeFour();
        const policy: OutboxBreakerPolicy = {
          ...POLICY,
          budgets: { [KEY]: 2 },
          warnRatio: 0.5,
          throttleRatio: 0.5,
          throttledCallsPerRun: 1,
        };
        const r = await expireHolds(container, { now: future(16 * MIN), breakerPolicy: policy });
        expect(callsFor(orders.map((o) => o.txn))).toBe(1);
        expect(r.cancelled).toEqual([orders[0]!.orderId]);
        expect(r.deferred).toEqual(orders.slice(1).map((o) => o.orderId));
        for (const o of orders.slice(1)) {
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
          expect(ex[0]!.detail).toMatchObject({ reason: "breaker_throttled" });
        }
      });

      it("RV2-V5: trip_count bám số đơn (mỗi kỳ nguội thêm đúng 1 đơn) — đơn lỗi đầu hàng vẫn không giữ được lượt thử", async () => {
        // Review vòng 2: chỉ xoay theo trip_count thì trip_count ≡ 0 (mod N) mỗi kỳ → lượt thử luôn rơi vào o1 (lỗi ổn định).
        const orders = await placeFour();
        const [o1] = orders;
        gateway.results.set(o1!.txn, { outcome: "unknown", transactionNo: null, reason: "http_500" });
        const t0 = future(16 * MIN);
        gateway.down = true;
        await expireHolds(container, { now: t0, breakerPolicy: POLICY });
        gateway.down = false;
        const all = orders.map((o) => ({ orderId: o.orderId, txn: o.txn }));
        const probes: string[] = [];
        for (let k = 1; k <= 5; k++) {
          const extra = await client.placeOrder([[VARIANTS[k % 4]!, 1]], "vnpay");
          all.push({ orderId: extra.orderId, txn: await txnOf(extra.orderId) });
          if (k === 1) {
            await pg().raw(`UPDATE job_breaker SET trip_count = ? WHERE breaker_key = ?`, [all.length, KEY]);
          }
          // T-164: o1 vừa lỗi sẽ được backoff tự đẩy ra khỏi tập tới hạn — kịch bản này cần o1 VẪN tới hạn và đứng đầu
          // hàng mỗi kỳ (dạng dữ liệu trước T-164: next_check_at NULL, hạn xét = hold_expires_at cũ nhất) để ghim đúng
          // thuộc tính "đơn vừa lỗi xuống cuối" của probeOrder chứ không nhờ backoff.
          await pg().raw(`UPDATE order_finance SET next_check_at = NULL WHERE order_id = ?`, [o1!.orderId]);
          const now = new Date(t0.getTime() + k * 5 * MIN + k);
          expect((await service().listExpiredHoldOrderIds(now, 100))[0]).toBe(o1!.orderId);
          const n = gateway.seen.length;
          await expireHolds(container, { now, breakerPolicy: POLICY });
          probes.push(gateway.seen[n] ?? "none");
        }
        // Kỳ 1: o1 nhận lượt thử (đơn vừa lỗi trước đó là o2) và lỗi; kỳ 2: o1 xuống cuối → đơn khác thử → đóng.
        expect(probes[0]).toBe(o1!.txn);
        expect(probes[1]).not.toBe(o1!.txn);
        expect((await breakerRow())?.state).toBe("closed");
        for (const o of all.slice(1)) expect((await fin(o.orderId)).state).toBe("cancelled");
        expect((await fin(o1!.orderId)).state).toBe("awaiting_payment");
        expect(gateway.seen.filter((t) => t === o1!.txn).length).toBeGreaterThanOrEqual(4); // o1 vẫn được hỏi
      });

      it("RV2-V4: chỉ còn MỘT đơn quá hạn và nó lỗi ổn định → nó vẫn được thử mỗi kỳ; có đơn mới → đơn mới nhận lượt thử", async () => {
        const placed = await client.placeOrder([["Trắng/M", 1]], "vnpay");
        const p = { orderId: placed.orderId, txn: await txnOf(placed.orderId) };
        gateway.results.set(p.txn, { outcome: "unknown", transactionNo: null, reason: "http_500" });
        const t0 = future(16 * MIN);
        await service().tripJobBreaker(KEY, "consecutive_failures", t0, ["closed"]);
        for (let k = 1; k <= 3; k++) {
          const r = await expireHolds(container, {
            now: new Date(t0.getTime() + k * 5 * MIN),
            breakerPolicy: POLICY,
          });
          expect(r.unknown).toEqual([p.orderId]); // lượt thử rơi vào chính p
        }
        expect(gateway.seen.filter((t) => t === p.txn)).toHaveLength(3);
        expect(await breakerRow()).toMatchObject({ state: "open", trip_count: 4 });
        const g = await client.placeOrder([["Đen/S", 1]], "vnpay");
        const r = await expireHolds(container, {
          now: new Date(t0.getTime() + 20 * MIN),
          breakerPolicy: POLICY,
        });
        expect(r.cancelled).toEqual([g.orderId]);
        expect(r.unknown).toEqual([p.orderId]);
        expect((await breakerRow())?.state).toBe("closed");
      });

      it("probeOrder: breaker đóng giữ nguyên; chưa đóng → xoay + đơn vừa lỗi xuống cuối (trừ khi chỉ còn nó)", () => {
        const snap = (state: "closed" | "open" | "half_open", trip_count: number, last: string | null) => ({
          state,
          trip_count,
          last_failed_event_id: last,
        });
        expect(probeOrder(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
        expect(probeOrder(["a", "b", "c"], snap("closed", 1, "a"))).toEqual(["a", "b", "c"]);
        expect(probeOrder(["a", "b", "c"], snap("open", 1, null))).toEqual(["b", "c", "a"]);
        expect(probeOrder(["a", "b", "c"], snap("open", 3, "a"))).toEqual(["b", "c", "a"]);
        expect(probeOrder(["a", "b", "c"], snap("half_open", 4, "b"))).toEqual(["c", "a", "b"]);
        expect(probeOrder(["a", "b", "c"], snap("open", 0, "zz"))).toEqual(["a", "b", "c"]);
        expect(probeOrder(["a"], snap("open", 7, "a"))).toEqual(["a"]);
        expect(probeOrder([], snap("open", 2, "a"))).toEqual([]);
      });

      it("rotate: xoay trái, n lớn hơn độ dài, mảng rỗng", () => {
        expect(rotate([1, 2, 3], 0)).toEqual([1, 2, 3]);
        expect(rotate([1, 2, 3], 1)).toEqual([2, 3, 1]);
        expect(rotate([1, 2, 3], 5)).toEqual([3, 1, 2]);
        expect(rotate([], 3)).toEqual([]);
      });

      describe("nghẽn đầu hàng → backoff theo đơn (T-164)", () => {
        const R91: QueryStatusResult = { outcome: "unknown", transactionNo: null, reason: "response_91" };
        const callsOf = (txn: string) => gateway.seen.filter((t) => t === txn).length;

        it("REPRO-B: đơn unknown kẹt đầu hàng (limit 2) không chặn đơn quá hạn mới; querydr không bị đốt mỗi phút", async () => {
          const warns: string[] = [];
          const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
          const spy = jest.spyOn(logger, "warn").mockImplementation((m: unknown) => {
            warns.push(String(m));
          });
          try {
            await reproB(warns);
          } finally {
            spy.mockRestore();
          }
        });

        const reproB = async (warns: string[]) => {
          const orders = await placeFour();
          const [o1, o2, o3, o4] = orders;
          for (const o of [o1!, o2!]) gateway.results.set(o.txn, R91);
          const t0 = future(16 * MIN);
          const runs = [];
          for (let k = 0; k < 5; k++) {
            runs.push(
              await expireHolds(container, {
                now: new Date(t0.getTime() + k * MIN),
                limit: 2,
                breakerPolicy: POLICY,
                backlogWarnAt: k === 4 ? 2 : undefined,
              }),
            );
          }
          // Ngay lượt t0+1: o1/o2 đã hẹn lại (hạn xét t0+1'−dung sai) xếp SAU o3/o4 (hạn xét = hold_expires_at cũ hơn)
          // → hai đơn mới được xét trước (ghim thứ tự COALESCE; sắp theo hold_expires_at thì lượt này hỏi lại o1/o2).
          expect([...runs[1]!.cancelled].sort()).toEqual([o3!.orderId, o4!.orderId].sort());
          expect(runs[1]!.unknown).toEqual([]);
          // Trước T-164: o3 vẫn awaiting_payment sau 5 lượt, querydr của o3 = 0, của o1/o2 = 5 mỗi đơn.
          for (const o of [o3!, o4!]) {
            expect((await fin(o.orderId)).state).toBe("cancelled");
            expect(callsOf(o.txn)).toBe(1);
            expect(await reserved(o.variant)).toBe(0);
          }
          // o1/o2: hỏi ở t0, t0+2, t0+4 (backoff 1 → 2 phút), không phải 5 lần; vẫn giữ hàng, đúng MỘT payment_unknown.
          for (const o of [o1!, o2!]) {
            expect(callsOf(o.txn)).toBe(3);
            expect((await fin(o.orderId)).state).toBe("awaiting_payment");
            expect(await reserved(o.variant)).toBe(1);
            const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
            expect(ex).toHaveLength(1);
          }
          // Tồn đọng đơn chưa rõ: đếm sau mỗi lượt; chạm ngưỡng (tiêm 2 ở lượt cuối) → log WARN (RUNBOOK §1); dưới
          // ngưỡng mặc định (50) → không WARN.
          expect(runs.map((r) => r.unknownBacklog)).toEqual([2, 2, 2, 2, 2]);
          const backlogWarns = warns.filter((m) => m.includes("đơn quá hạn chưa rõ thanh toán"));
          expect(backlogWarns).toHaveLength(1);
          expect(backlogWarns[0]).toContain("2 đơn quá hạn chưa rõ thanh toán");
        };

        const dueOf = async (orderId: string) => {
          const f = await fin(orderId);
          return f.next_check_at === null ? null : new Date(f.next_check_at);
        };

        it("backoff 1 → 2 → 4 … → 60 phút (trần); trước hạn không hỏi; vẫn giữ hàng, một payment_unknown; trả lời rõ → hủy", async () => {
          const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
          const txn = await txnOf(o.orderId);
          gateway.results.set(txn, R91);
          let now = future(16 * MIN);
          const delays: number[] = [];
          for (let k = 1; k <= 9; k++) {
            expect((await expireHolds(container, { now, breakerPolicy: POLICY })).unknown).toEqual([
              o.orderId,
            ]);
            expect(callsOf(txn)).toBe(k);
            const f = await fin(o.orderId);
            expect(f.hold_check_attempts).toBe(k);
            const due = new Date(f.next_check_at!);
            delays.push((due.getTime() - now.getTime() + SLACK) / MIN);
            // 1 ms trước hạn → không xét, không gọi querydr.
            const early = await expireHolds(container, {
              now: new Date(due.getTime() - 1),
              breakerPolicy: POLICY,
            });
            expect(early).toMatchObject({ unknown: [], skipped: [], cancelled: [] });
            expect(callsOf(txn)).toBe(k);
            now = due; // đúng hạn (biên ≤) → xét
          }
          expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]); // mỗi mốc trừ dung sai SLACK
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          expect(await reserved("Đen/S")).toBe(1);
          expect(
            await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" }),
          ).toHaveLength(1);
          gateway.results.delete(txn); // VNPAY trả lời "chưa trả"
          expect((await expireHolds(container, { now, breakerPolicy: POLICY })).cancelled).toEqual([
            o.orderId,
          ]);
          expect(await reserved("Đen/S")).toBe(0);
        });

        it("breaker hoãn → không tăng số mũ, chỉ lùi 1 phút; breaker đóng → hỏi lại ngay lượt kế tiếp", async () => {
          const o = await client.placeOrder([["Trắng/S", 1]], "vnpay");
          const txn = await txnOf(o.orderId);
          gateway.results.set(txn, R91);
          const t0 = future(16 * MIN);
          await expireHolds(container, { now: t0, breakerPolicy: POLICY }); // unknown → attempts 1, hạn t0+1
          expect((await fin(o.orderId)).hold_check_attempts).toBe(1);
          await service().tripJobBreaker(KEY, "consecutive_failures", new Date(t0.getTime() + 5 * MIN), [
            "closed",
          ]);
          for (let k = 1; k <= 3; k++) {
            const now = new Date(t0.getTime() + k * MIN);
            expect((await expireHolds(container, { now, breakerPolicy: POLICY })).deferred).toEqual([
              o.orderId,
            ]);
            expect((await fin(o.orderId)).hold_check_attempts).toBe(1);
            expect((await dueOf(o.orderId))!.getTime()).toBe(now.getTime() + MIN - SLACK);
          }
          expect(callsOf(txn)).toBe(1);
          // Hết nguội (t0+5): lượt thử rơi vào chính đơn này → unknown → attempts 2 (hạn +2 phút).
          const t5 = new Date(t0.getTime() + 5 * MIN);
          expect((await expireHolds(container, { now: t5, breakerPolicy: POLICY })).unknown).toEqual([
            o.orderId,
          ]);
          expect(callsOf(txn)).toBe(2);
          expect((await fin(o.orderId)).hold_check_attempts).toBe(2);
          expect((await dueOf(o.orderId))!.getTime()).toBe(t5.getTime() + 2 * MIN - SLACK);
        });

        it("IPN đến khi đơn đang backoff: thành công → xác nhận ngay, lượt sau không hỏi/không hủy; thất bại → bỏ hẹn, lượt kế tiếp hủy ngay", async () => {
          const ok = await client.placeOrder([["Đen/M", 1]], "vnpay");
          const ko = await client.placeOrder([["Trắng/M", 1]], "vnpay");
          const [okTxn, koTxn] = [await txnOf(ok.orderId), await txnOf(ko.orderId)];
          gateway.results.set(okTxn, R91);
          gateway.results.set(koTxn, R91);
          let now = future(16 * MIN);
          for (let k = 0; k < 3; k++) {
            await expireHolds(container, { now, breakerPolicy: POLICY });
            now = (await dueOf(ok.orderId))!;
          }
          // Cả hai đang backoff 4 phút (attempts 3); IPN tới giữa chừng.
          expect((await fin(ok.orderId)).hold_check_attempts).toBe(3);
          const mid = new Date(now.getTime() - 2 * MIN);
          expect((await ipn(api, signer.pay(ok.paymentUrl, "success"))).data).toEqual(R.success);
          expect((await fin(ok.orderId)).state).toBe("confirmed");
          expect((await ipn(api, signer.pay(ko.paymentUrl, "cancelled"))).data).toEqual(R.success);
          expect((await fin(ko.orderId)).state).toBe("awaiting_payment");
          expect(await dueOf(ko.orderId)).toBeNull();
          const [okCalls, koCalls] = [callsOf(okTxn), callsOf(koTxn)];
          // Lượt kế tiếp (chưa tới hạn backoff cũ): đơn IPN thất bại hủy ngay, không querydr (không còn attempt mở).
          const r = await expireHolds(container, { now: mid, breakerPolicy: POLICY });
          expect(r.cancelled).toEqual([ko.orderId]);
          expect(callsOf(koTxn)).toBe(koCalls);
          expect(await reserved("Trắng/M")).toBe(0);
          // Đơn đã xác nhận: tới hạn backoff cũ cũng không bị xét lại.
          const r2 = await expireHolds(container, {
            now: new Date(now.getTime() + 60 * MIN),
            breakerPolicy: POLICY,
          });
          expect([...r2.cancelled, ...r2.unknown, ...r2.confirmed]).not.toContain(ok.orderId);
          expect(callsOf(okTxn)).toBe(okCalls);
          expect((await fin(ok.orderId)).state).toBe("confirmed");
          expect(await reserved("Đen/M")).toBe(1);
          expect(
            await service().listOpsExceptions({ order_id: ok.orderId, kind: "late_payment" }),
          ).toHaveLength(0);
        });

        it("hai lượt song song: mỗi đơn hỏi đúng một lần mỗi kỳ, một payment_unknown, số mũ tăng đúng 1; kết cục hủy đúng một lần", async () => {
          const orders = await placeFour();
          for (const o of orders) gateway.results.set(o.txn, R91);
          const t0 = future(16 * MIN);
          const [a, b] = await Promise.all([
            expireHolds(container, { now: t0, breakerPolicy: POLICY }),
            expireHolds(container, { now: t0, breakerPolicy: POLICY }),
          ]);
          expect([...a.unknown, ...b.unknown].sort()).toEqual(orders.map((o) => o.orderId).sort());
          for (const o of orders) {
            expect(callsOf(o.txn)).toBe(1);
            expect((await fin(o.orderId)).hold_check_attempts).toBe(1);
            expect((await dueOf(o.orderId))!.getTime()).toBe(t0.getTime() + MIN - SLACK);
          }
          const [o1] = orders;
          gateway.results.delete(o1!.txn); // o1: VNPAY trả lời "chưa trả"
          const t1 = new Date(t0.getTime() + MIN);
          const [c, d] = await Promise.all([
            expireHolds(container, { now: t1, breakerPolicy: POLICY }),
            expireHolds(container, { now: t1, breakerPolicy: POLICY }),
          ]);
          expect([...c.cancelled, ...d.cancelled]).toEqual([o1!.orderId]);
          expect(
            (await service().listOutboxEvents({ aggregate_id: o1!.orderId })).filter(
              (e) => e.type === "order.cancelled",
            ),
          ).toHaveLength(1);
          for (const o of orders.slice(1)) {
            expect(callsOf(o.txn)).toBe(2);
            expect((await fin(o.orderId)).hold_check_attempts).toBe(2);
            expect(
              await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" }),
            ).toHaveLength(1);
          }
        });

        it("ca biên: next_check_at NULL (dữ liệu trước T-164) đến hạn ngay, số mũ đi tiếp; biên ≤ theo mốc UTC tuyệt đối; cột timestamptz", async () => {
          const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
          const txn = await txnOf(o.orderId);
          gateway.results.set(txn, R91);
          const col = (
            await pg().raw(
              `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                WHERE table_name = 'order_finance' AND column_name IN ('next_check_at', 'hold_check_attempts')
                ORDER BY column_name`,
            )
          ).rows;
          expect(col).toEqual([
            {
              column_name: "hold_check_attempts",
              data_type: "integer",
              is_nullable: "NO",
              column_default: "0",
            },
            {
              column_name: "next_check_at",
              data_type: "timestamp with time zone",
              is_nullable: "YES",
              column_default: null,
            },
          ]);
          // Dòng cũ/nhân viên bỏ hẹn bằng SQL: NULL + số mũ đã có → xét ngay, backoff tiếp từ số mũ đó (2^3 = 8 phút).
          await pg().raw(
            `UPDATE order_finance SET next_check_at = NULL, hold_check_attempts = 3 WHERE order_id = ?`,
            [o.orderId],
          );
          const now = future(16 * MIN);
          expect(await service().listExpiredHoldOrderIds(now, 100)).toContain(o.orderId);
          expect((await expireHolds(container, { now, breakerPolicy: POLICY })).unknown).toEqual([o.orderId]);
          expect((await fin(o.orderId)).hold_check_attempts).toBe(4);
          const due = (await dueOf(o.orderId))!;
          expect(due.getTime() - now.getTime()).toBe(8 * MIN - SLACK);
          // Biên theo mốc tuyệt đối (timestamptz ↔ Date UTC): due−1ms chưa, due thì có.
          expect(await service().listExpiredHoldOrderIds(new Date(due.getTime() - 1), 100)).not.toContain(
            o.orderId,
          );
          expect(await service().listExpiredHoldOrderIds(due, 100)).toContain(o.orderId);
          // Cùng vị từ trong phiên múi +07 (SET LOCAL — chỉ transaction này): kết quả không đổi, giá trị lưu đúng mốc UTC.
          const tz = await pg().transaction(async (trx) => {
            await trx.raw(`SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh'`);
            return (
              await trx.raw(
                `SELECT (next_check_at IS NULL OR next_check_at <= ?) AS due_before,
                        (next_check_at IS NULL OR next_check_at <= ?) AS due_at,
                        to_char(next_check_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS utc,
                        current_setting('TimeZone') AS session_tz
                   FROM order_finance WHERE order_id = ?`,
                [new Date(due.getTime() - 1), due, o.orderId],
              )
            ).rows[0] as { due_before: boolean; due_at: boolean; utc: string; session_tz: string };
          });
          expect(tz).toEqual({
            due_before: false,
            due_at: true,
            utc: due.toISOString(),
            session_tz: "Asia/Ho_Chi_Minh",
          });
        });

        it("lỗi ở pha chốt hủy (hủy native xong) → hẹn lại 1 phút KHÔNG tăng số mũ (lượt dừng như trước); lượt sau xử lý đơn khác thay vì kẹt ở nó", async () => {
          const orders = await placeFour();
          const [o1] = orders;
          const svc = service() as unknown as {
            cancelExpiredOrder: (id: string, r: string) => Promise<boolean>;
          };
          const orig = svc.cancelExpiredOrder;
          svc.cancelExpiredOrder = async function (this: unknown, id: string, r: string) {
            if (id === o1!.orderId) throw new Error("lỗi giả lập khi chốt hủy");
            return orig.call(this, id, r);
          };
          const t0 = future(16 * MIN);
          try {
            await expect(expireHolds(container, { now: t0, breakerPolicy: POLICY })).rejects.toThrow(
              "lỗi giả lập khi chốt hủy",
            );
            expect((await fin(o1!.orderId)).hold_check_attempts).toBe(0);
            expect((await dueOf(o1!.orderId))!.getTime()).toBe(t0.getTime() + MIN - SLACK);
            // Cùng thời điểm: o1 đang hẹn → các đơn còn lại được xử lý (trước T-164: ném lại ở o1 mãi).
            const r = await expireHolds(container, { now: t0, breakerPolicy: POLICY });
            expect([...r.cancelled].sort()).toEqual(
              orders
                .slice(1)
                .map((o) => o.orderId)
                .sort(),
            );
          } finally {
            svc.cancelExpiredOrder = orig;
          }
          // Hết lỗi, tới hạn → hủy nốt o1 (native đã hủy ở lần trước — idempotent).
          const r = await expireHolds(container, {
            now: new Date(t0.getTime() + MIN),
            breakerPolicy: POLICY,
          });
          expect(r.cancelled).toEqual([o1!.orderId]);
          expect(await reserved(o1!.variant)).toBe(0);
        });

        it("lỗi trước pha chốt hủy (sau querydr chưa rõ) → backoff tăng số mũ; không hủy, không nhả hàng", async () => {
          const o = await client.placeOrder([["Trắng/S", 1]], "vnpay");
          const txn = await txnOf(o.orderId);
          gateway.results.set(txn, R91);
          const svc = service() as unknown as { openOpsException: (i: unknown) => Promise<boolean> };
          const orig = svc.openOpsException;
          svc.openOpsException = async () => {
            throw new Error("lỗi giả lập khi mở ngoại lệ");
          };
          const t0 = future(16 * MIN);
          try {
            await expect(expireHolds(container, { now: t0, breakerPolicy: POLICY })).rejects.toThrow(
              "lỗi giả lập khi mở ngoại lệ",
            );
          } finally {
            svc.openOpsException = orig;
          }
          expect((await fin(o.orderId)).hold_check_attempts).toBe(1);
          expect((await dueOf(o.orderId))!.getTime()).toBe(t0.getTime() + MIN - SLACK);
          expect((await fin(o.orderId)).state).toBe("awaiting_payment");
          expect(await reserved("Trắng/S")).toBe(1);
        });

        it("dung sai lịch: lượt kế tiếp bắt đầu sớm hơn 60 s vài trăm ms vẫn tới hạn (bước 1 phút không thành 2 phút)", async () => {
          const o = await client.placeOrder([["Trắng/M", 1]], "vnpay");
          const txn = await txnOf(o.orderId);
          gateway.results.set(txn, R91);
          const t0 = future(16 * MIN);
          await expireHolds(container, { now: t0, breakerPolicy: POLICY });
          // Cron "* * * * *": lượt sau có thể bắt đầu ở t0 + 59,6 s (lượt trước bắt đầu trễ 400 ms).
          const r = await expireHolds(container, {
            now: new Date(t0.getTime() + MIN - 400),
            breakerPolicy: POLICY,
          });
          expect(r.unknown).toEqual([o.orderId]);
          expect(callsOf(txn)).toBe(2);
          // Nhưng không sớm hơn dung sai: t0 + 55 s − 1 ms của lượt kế tiếp chưa tới hạn.
          const due = (await dueOf(o.orderId))!;
          const now2 = new Date(t0.getTime() + MIN - 400);
          expect(due.getTime()).toBe(now2.getTime() + 2 * MIN - SLACK);
          expect(
            (await expireHolds(container, { now: new Date(due.getTime() - 1), breakerPolicy: POLICY }))
              .unknown,
          ).toEqual([]);
        });
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
        // RNG tiêm (T-093: backoff có jitter) → khoảng chờ tất định để so đúng giá trị.
        const random = () => 0.25;

        let now = base;
        for (let attempt = 1; attempt < OUTBOX_POLICY.maxAttempts; attempt++) {
          expect((await dispatchOutbox(container, { now, handlers: failing, random })).retried).toEqual([
            "test.fail:1",
          ]);
          // Chưa tới hạn thử lại → không nhận.
          expect((await dispatchOutbox(container, { now, handlers: failing, random })).retried).toEqual([]);
          const [ev] = await s.listOutboxEvents({ event_key: "test.fail:1" });
          expect(ev).toMatchObject({ state: "failed", attempts: attempt, last_error: "SMTP 503" });
          expect(new Date(ev!.next_attempt_at).getTime() - now.getTime()).toBe(
            outboxBackoffMs(attempt, random),
          );
          now = new Date(ev!.next_attempt_at);
        }
        expect((await dispatchOutbox(container, { now, handlers: failing, random })).dead).toEqual([
          "test.fail:1",
        ]);
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
