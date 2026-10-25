import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { dispatchOutbox, OUTBOX_POLICY, outboxBackoffMs } from "../../src/lib/checkout/jobs";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import {
  LogNotificationAdapter,
  setNotificationAdapterForTest,
  type NotificationAdapter,
  type OutgoingMessage,
} from "../../src/lib/notify/adapters";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { NOTIFY_MODULE } from "../../src/modules/notify";
import type NotifyModuleService from "../../src/modules/notify/service";
import { checkoutClient, CONTACT, DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/** Adapter test chỉ phản ứng với sự kiện có tiền tố của test — dispatcher nền (giờ thật) không làm nhiễu số đếm. */
class ScriptedAdapter implements NotificationAdapter {
  readonly name = "scripted";
  readonly live = false;
  failing = true;
  readonly attempts: OutgoingMessage[] = [];
  readonly delivered: OutgoingMessage[] = [];
  constructor(private readonly prefix: string) {}
  async send(m: OutgoingMessage) {
    if (!m.messageKey.includes(this.prefix)) return { providerMessageId: null };
    this.attempts.push(m);
    if (this.failing) throw new Error(`SMTP 451 từ chối ${m.to} (${CONTACT.phone})`);
    this.delivered.push(m);
    return { providerMessageId: `prov-${this.delivered.length}` };
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const client = checkoutClient(api, () => fx);
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const notify = () => container.resolve<NotifyModuleService>(NOTIFY_MODULE);
    let seq = 0;

    beforeAll(() => setVnpayGatewayForTest(gateway));
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setNotificationAdapterForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container);
      setNotificationAdapterForTest(null);
    });

    /** Sự kiện outbox riêng của test, hạn ở tương lai (dispatcher nền không nhận). */
    async function enqueue(type: string, orderId: string, payload: Record<string, unknown> = {}) {
      seq += 1;
      const key = `t029-${seq}:${type}:${orderId}`;
      const at = new Date(Date.now() + (60 + seq) * 60_000);
      await checkout().insertOutbox(key, orderId, type, { order_id: orderId, ...payload }, undefined, at);
      return { key, at };
    }
    const outboxOf = async (key: string) => (await checkout().listOutboxEvents({ event_key: key }))[0]!;
    const messagesOf = (key: string) => notify().listOutboundMessages({ message_key: `notify:${key}:email` });

    describe("AT18 — adapter lỗi: đơn nguyên vẹn, outbox retry, gửi lại không trùng message key", () => {
      it("lỗi → retry lũy thừa; hết lỗi → gửi đúng 1 lần; phát lại sự kiện → không gửi thêm", async () => {
        const o = await client.placeOrder([["Đen/M", 1]], "cod");
        const finBefore = (await checkout().listOrderFinances({ order_id: o.orderId }))[0]!;
        const { key, at } = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
        const adapter = new ScriptedAdapter(key);
        setNotificationAdapterForTest(adapter);

        const r1 = await dispatchOutbox(container, { now: at });
        expect(r1.retried).toContain(key);
        const ev1 = await outboxOf(key);
        expect(ev1).toMatchObject({ state: "failed", attempts: 1 });
        expect(new Date(ev1.next_attempt_at).getTime() - at.getTime()).toBe(outboxBackoffMs(1));
        // Lỗi ghi lại không lộ email/SĐT.
        expect(ev1.last_error).not.toMatch(/an@example\.vn|0912|345 678/);
        const [m1] = await messagesOf(key);
        expect(m1).toMatchObject({ state: "failed", attempts: 1, live: false, template: "order.placed" });
        expect(m1!.last_error).not.toMatch(/an@example\.vn|0912/);

        // Đơn nguyên vẹn.
        const finAfter = (await checkout().listOrderFinances({ order_id: o.orderId }))[0]!;
        expect(finAfter).toMatchObject({
          state: finBefore.state,
          total: finBefore.total,
          version: finBefore.version,
        });
        const order = await container.resolve(Modules.ORDER).retrieveOrder(o.orderId);
        expect(order.status).not.toBe("canceled");

        adapter.failing = false;
        const r2 = await dispatchOutbox(container, { now: new Date(ev1.next_attempt_at) });
        expect(r2.sent).toContain(key);
        expect(adapter.delivered).toHaveLength(1);
        expect(adapter.delivered[0]).toMatchObject({
          template: "order.placed",
          channel: "email",
          to: CONTACT.email,
        });
        expect(adapter.delivered[0]!.subject).toContain("Đã nhận đơn");
        const [m2] = await messagesOf(key);
        expect(m2).toMatchObject({ state: "sent", attempts: 2, provider_message_id: "prov-1" });

        // Phát lại cùng sự kiện (vd dispatcher chết sau khi gửi, trước khi đánh dấu outbox) → không gửi lần hai.
        const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        await pg.raw(`UPDATE outbox_event SET state = 'pending', next_attempt_at = ? WHERE event_key = ?`, [
          at,
          key,
        ]);
        const r3 = await dispatchOutbox(container, { now: at });
        expect(r3.sent).toContain(key);
        expect(adapter.attempts).toHaveLength(2);
        expect(await messagesOf(key)).toHaveLength(1);
      });

      it("lỗi quá trần → dừng thử, ngoại lệ notification_failed; đơn không đổi", async () => {
        const o = await client.placeOrder([["Trắng/S", 1]], "cod");
        const { key, at } = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
        setNotificationAdapterForTest(new ScriptedAdapter(key));
        let now = at;
        for (let i = 1; i < OUTBOX_POLICY.maxAttempts; i++) {
          expect((await dispatchOutbox(container, { now })).retried).toContain(key);
          now = new Date((await outboxOf(key)).next_attempt_at);
        }
        expect((await dispatchOutbox(container, { now })).dead).toContain(key);
        expect(await outboxOf(key)).toMatchObject({ state: "dead", attempts: OUTBOX_POLICY.maxAttempts });
        const ex = await checkout().listOpsExceptions({
          kind: "notification_failed" as never,
          order_id: o.orderId,
        });
        expect(ex).toHaveLength(1);
        expect(JSON.stringify(ex[0]!.detail)).not.toMatch(/an@example\.vn|0912/);
        expect((await checkout().listOrderFinances({ order_id: o.orderId }))[0]!.state).toBe("placed");
      });
    });

    describe("adapter log mặc định — không gửi thật, không PII trong log", () => {
      it("order.placed / order.confirmed / order.lookup_link / shipment.shipped: log đã che, outbound live=false", async () => {
        const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
        const lines: string[] = [];
        const spies = (["info", "warn", "error", "debug", "log"] as const).flatMap((lvl) =>
          typeof (logger as unknown as Record<string, unknown>)[lvl] === "function"
            ? [
                jest
                  .spyOn(logger as unknown as Record<string, (...a: unknown[]) => void>, lvl)
                  .mockImplementation((...args: unknown[]) => {
                    lines.push(args.map(String).join(" "));
                  }),
              ]
            : [],
        );
        try {
          setNotificationAdapterForTest(new LogNotificationAdapter());
          const cod = await client.placeOrder([["Đen/S", 1]], "cod");
          const vn = await client.placeOrder([["Đen/M", 1]], "vnpay");
          expect((await ipn(api, gateway.mock.pay(vn.paymentUrl, "success"))).data.RspCode).toBe("00");
          const link = "https://shop.example.vn/don-hang/tra-cuu?t=secret-token-abc123";
          const events = [
            await enqueue("order.placed_pending", cod.orderId, { payment_method: "cod" }),
            await enqueue("order.confirmed", vn.orderId),
            await enqueue("order.lookup_link", cod.orderId, { link }),
            await enqueue("shipment.shipped", vn.orderId, { provider_order_code: "GHNMOCK000123" }),
          ];
          const last = events[events.length - 1]!.at;
          const r = await dispatchOutbox(container, { now: last });
          for (const e of events) expect(r.sent).toContain(e.key);
          const templates: string[] = [];
          for (const e of events) {
            const [m] = await messagesOf(e.key);
            expect(m).toMatchObject({
              state: "sent",
              live: false,
              adapter: "log",
              recipient_masked: "a***@example.vn",
            });
            templates.push(m!.template);
          }
          expect(templates).toEqual([
            "order.placed",
            "order.confirmed",
            "order.lookup_link",
            "shipment.shipped",
          ]);
          const notifyLines = lines.filter((l) => l.includes("[notify:log]"));
          expect(notifyLines.length).toBeGreaterThanOrEqual(4);
          const all = lines.join("\n");
          for (const pii of [
            CONTACT.name,
            CONTACT.email,
            "0912345678",
            CONTACT.phone,
            "secret-token-abc123",
          ]) {
            expect(all).not.toContain(pii);
          }
        } finally {
          for (const s of spies) s.mockRestore();
        }
      });

      it("AT34 — không gửi xác nhận sai: order.confirmed khi đơn chưa xác nhận, đơn online chưa thu → không gửi", async () => {
        const cod = await client.placeOrder([["Đen/S", 1]], "cod");
        const vn = await client.placeOrder([["Đen/M", 1]], "vnpay");
        const a = await enqueue("order.confirmed", cod.orderId);
        const b = await enqueue("order.placed_pending", vn.orderId, { payment_method: "vnpay" });
        const adapter = new ScriptedAdapter("t029-");
        adapter.failing = false;
        setNotificationAdapterForTest(adapter);
        const r = await dispatchOutbox(container, { now: b.at });
        expect(r.sent).toEqual(expect.arrayContaining([a.key, b.key]));
        expect(adapter.attempts).toHaveLength(0);
        expect(await messagesOf(a.key)).toHaveLength(0);
        expect(await notify().listOutboundMessages({ message_key: `notify:${b.key}:email` })).toHaveLength(0);
      });
    });
  },
});
