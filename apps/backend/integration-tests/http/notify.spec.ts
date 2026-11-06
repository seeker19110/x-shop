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
    /**
     * Ghi THẲNG bằng SQL, bỏ qua kiểm lúc ghi (T-149) — mô phỏng dòng cũ ghi trước khi có kiểm, hoặc ghi lách qua đường
     * khác: dispatcher vẫn phải chặn khi nhận (lớp thứ hai).
     */
    async function enqueueRaw(type: string, orderId: string, payload: Record<string, unknown>) {
      seq += 1;
      const key = `t029-${seq}:${type}:${orderId}`;
      const at = new Date(Date.now() + (60 + seq) * 60_000);
      await container.resolve(ContainerRegistrationKeys.PG_CONNECTION).raw(
        `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, next_attempt_at)
           VALUES (?, ?, ?, ?, ?::jsonb, 'pending', ?)`,
        [`obx_raw${seq}`, key, orderId, type, JSON.stringify({ order_id: orderId, ...payload }), at],
      );
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
        // Backoff lần 1 có equal jitter (T-093): trong [base/2, base) — không tiêm RNG ở đây, chỉ kiểm khoảng.
        const wait1 = new Date(ev1.next_attempt_at).getTime() - at.getTime();
        expect(wait1).toBeGreaterThanOrEqual(outboxBackoffMs(1, () => 0));
        expect(wait1).toBeLessThan(OUTBOX_POLICY.baseDelayMs);
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

    describe("T-093 — payload sai / lỗi vĩnh viễn → dead ngay; lỗi tạm theo backoff + Retry-After", () => {
      /** Adapter ném lỗi do test chọn cho message key có tiền tố `prefix`. */
      class ThrowingAdapter implements NotificationAdapter {
        readonly name = "throwing";
        readonly live = false;
        calls = 0;
        constructor(
          private readonly prefix: string,
          private readonly error: () => Error,
        ) {}
        async send(m: OutgoingMessage) {
          if (!m.messageKey.includes(this.prefix)) return { providerMessageId: null };
          this.calls += 1;
          throw this.error();
        }
      }
      const exceptionOf = async (orderId: string, key: string) =>
        (
          await checkout().listOpsExceptions({ kind: "notification_failed" as never, order_id: orderId })
        ).filter((e) => (e.detail as { event_key?: string } | null)?.event_key === key);

      it("payload sai schema (token thô, khoá bí mật, object lồng) → dead ở lần nhận đầu kèm lý do, không gửi; lượt vẫn xử lý sự kiện đúng", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "cod");
        // Hình dạng cũ của producer tra cứu (trước T-149): token thô trong payload.
        const rawToken = await enqueueRaw("order.lookup_link", o.orderId, {
          token: "dG9rZW4tdGh1LW5naGllbQ.bWFjLXRodS1uZ2hpZW0",
          expires_at: "2026-01-01T00:00:00.000Z",
        });
        const secret = await enqueueRaw("order.confirmed", o.orderId, { password: "mat-khau-bi-mat-123" });
        const nested = await enqueueRaw("order.placed_pending", o.orderId, {
          cart: { items: [{ sku: "X" }] },
        });
        const good = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
        const adapter = new ScriptedAdapter("t029-");
        adapter.failing = false;
        setNotificationAdapterForTest(adapter);

        const r = await dispatchOutbox(container, { now: good.at });
        expect(r.dead).toEqual(expect.arrayContaining([rawToken.key, secret.key, nested.key]));
        expect(r.sent).toContain(good.key);
        expect(r.retried).not.toEqual(expect.arrayContaining([rawToken.key]));

        for (const [ev, field] of [
          [rawToken, "token"],
          [secret, "password"],
          [nested, "cart"],
        ] as const) {
          const row = await outboxOf(ev.key);
          expect(row).toMatchObject({ state: "dead", attempts: 1 });
          expect(row.last_error).toContain("payload không hợp lệ");
          expect(row.last_error).toContain(`${field}:`);
          expect(await messagesOf(ev.key)).toHaveLength(0);
          const ex = await exceptionOf(o.orderId, ev.key);
          expect(ex).toHaveLength(1);
          expect(ex[0]!.detail).toMatchObject({ dead_reason: "invalid_payload", attempts: 1 });
        }
        // Lý do không chứa giá trị của trường (bí mật/PII).
        const secretRow = await outboxOf(secret.key);
        expect(secretRow.last_error).not.toContain("mat-khau-bi-mat-123");
        expect(JSON.stringify(await exceptionOf(o.orderId, secret.key))).not.toContain("mat-khau-bi-mat-123");
        expect(adapter.delivered.filter((m) => m.messageKey.includes(good.key))).toHaveLength(1);
      });

      it("đồng thời: hai dispatcher cùng lúc gặp payload sai → dead đúng một lần, một ngoại lệ", async () => {
        const o = await client.placeOrder([["Trắng/M", 1]], "cod");
        const bad = await enqueueRaw("order.lookup_link", o.orderId, { link: "ftp://khong-hop-le" });
        const [a, b] = await Promise.all([
          dispatchOutbox(container, { now: bad.at }),
          dispatchOutbox(container, { now: bad.at }),
        ]);
        expect([...a.dead, ...b.dead].filter((k) => k === bad.key)).toHaveLength(1);
        expect(await outboxOf(bad.key)).toMatchObject({ state: "dead", attempts: 1 });
        expect(await exceptionOf(o.orderId, bad.key)).toHaveLength(1);
      });

      it("adapter trả 4xx vĩnh viễn (422) → dead ngay lần 1, ngoại lệ permanent_error; 408 và 429 không có Retry-After → retry backoff", async () => {
        const o = await client.placeOrder([["Đen/M", 1]], "cod");
        const p = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
        const perm = new ThrowingAdapter(p.key, () =>
          Object.assign(new Error(`ESP 422 địa chỉ ${CONTACT.email} không hợp lệ`), { status: 422 }),
        );
        setNotificationAdapterForTest(perm);
        const r1 = await dispatchOutbox(container, { now: p.at });
        expect(r1.dead).toContain(p.key);
        expect(perm.calls).toBe(1);
        const row = await outboxOf(p.key);
        expect(row).toMatchObject({ state: "dead", attempts: 1 });
        expect(row.last_error).not.toContain(CONTACT.email);
        const ex = await exceptionOf(o.orderId, p.key);
        expect(ex).toHaveLength(1);
        expect(ex[0]!.detail).toMatchObject({ dead_reason: "permanent_error" });
        expect(JSON.stringify(ex[0]!.detail)).not.toContain(CONTACT.email);
        // Đơn không bị đụng tới.
        expect((await checkout().listOrderFinances({ order_id: o.orderId }))[0]!.state).toBe("placed");

        for (const status of [408, 429]) {
          const q = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
          const tmp = new ThrowingAdapter(q.key, () => Object.assign(new Error(`ESP ${status}`), { status }));
          setNotificationAdapterForTest(tmp);
          const r = await dispatchOutbox(container, { now: q.at });
          expect(r.retried).toContain(q.key);
          const ev = await outboxOf(q.key);
          expect(ev).toMatchObject({ state: "failed", attempts: 1 });
          const wait = new Date(ev.next_attempt_at).getTime() - q.at.getTime();
          expect(wait).toBeGreaterThanOrEqual(OUTBOX_POLICY.baseDelayMs / 2);
          expect(wait).toBeLessThan(OUTBOX_POLICY.baseDelayMs);
        }
      });

      it("lỗi tạm kèm Retry-After (429, 600 s) → hẹn lại đúng sau Retry-After (lớn hơn backoff), không dead", async () => {
        const o = await client.placeOrder([["Trắng/S", 1]], "cod");
        const q = await enqueue("order.placed_pending", o.orderId, { payment_method: "cod" });
        setNotificationAdapterForTest(
          new ThrowingAdapter(q.key, () =>
            Object.assign(new Error("ESP 429"), { status: 429, retryAfterMs: 600_000 }),
          ),
        );
        const r = await dispatchOutbox(container, { now: q.at, random: () => 0.5 });
        expect(r.retried).toContain(q.key);
        const ev = await outboxOf(q.key);
        expect(ev).toMatchObject({ state: "failed", attempts: 1 });
        expect(new Date(ev.next_attempt_at).getTime() - q.at.getTime()).toBe(600_000);
      });
    });

    describe("T-149 — kiểm payload lúc GHI: producer sai shape lỗi ngay, không đợi tới DLQ", () => {
      /** Lỗi ném ra (hoặc null nếu không ném). */
      const errorOf = (p: Promise<unknown>) =>
        p.then(
          () => null,
          (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
        );

      it("insertOutbox: token thô / link mang token / khoá bí mật / thiếu order_id / object lồng → ném, không ghi dòng nào; lý do không chứa giá trị", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "cod");
        const bad: Array<[string, Record<string, unknown>, string]> = [
          ["order.lookup_link", { order_id: o.orderId, token: "dG9rZW4.bWFj", expires_at: "x" }, "token"],
          [
            "order.lookup_link",
            { order_id: o.orderId, link: "https://shop.example.vn/tra-cuu-don/xac-thuc?token=dG9rZW4.bWFj" },
            "link",
          ],
          ["order.confirmed", { display_ref: "XS-1" }, "order_id"],
          ["order.placed_pending", { order_id: o.orderId, cart: { items: [{ sku: "X" }] } }, "cart"],
          ["test.x", { password: "mat-khau-bi-mat-123" }, "password"],
        ];
        for (const [i, [type, payload, field]] of bad.entries()) {
          const key = `t149-bad-${i}:${type}`;
          const err = await errorOf(checkout().insertOutbox(key, o.orderId, type, payload));
          expect(err?.message).toContain("payload không hợp lệ");
          expect(err?.message).toContain(`${field}:`);
          expect(err?.message).not.toMatch(/mat-khau-bi-mat-123|dG9rZW4/);
          expect(await checkout().listOutboxEvents({ event_key: key })).toHaveLength(0);
        }
        // Đúng shape → ghi bình thường.
        const okKey = `t149-ok:order.lookup_link:${o.orderId}`;
        await checkout().insertOutbox(okKey, o.orderId, "order.lookup_link", { order_id: o.orderId });
        expect(await checkout().listOutboxEvents({ event_key: okKey })).toHaveLength(1);
      });

      it("finalizeAttempt: outbox sai shape → ném TRƯỚC khi mở transaction (không đụng attempt/đơn)", async () => {
        const err = await errorOf(
          checkout().finalizeAttempt(
            {
              attempt_id: "catt_t149",
              order_id: "order_t149",
              cart_id: "cart_t149",
              cart_version: 1,
              order_state: "placed",
              hold_expires_at: null,
              cod_confirm_by: null,
              outbox: {
                event_key: "order.placed_pending:order_t149",
                type: "order.placed_pending",
                payload: { order_id: "order_t149", payment_method: "bitcoin" },
              },
            },
            {},
          ),
        );
        // Không có kiểm lúc ghi thì lỗi sẽ là "order_finance … không còn ở trạng thái preparing" (từ transaction).
        expect(err?.message).toContain("payload không hợp lệ");
        expect(err?.message).toContain("payment_method:");
        expect(
          await checkout().listOutboxEvents({ event_key: "order.placed_pending:order_t149" }),
        ).toHaveLength(0);
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
          const events = [
            await enqueue("order.placed_pending", cod.orderId, { payment_method: "cod" }),
            await enqueue("order.confirmed", vn.orderId),
            // T-149: payload chỉ có ID; bộ xử lý phát hành token + dựng liên kết lúc gửi.
            await enqueue("order.lookup_link", cod.orderId),
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
              recipient_masked: "a***@example.test",
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
          for (const pii of [CONTACT.name, CONTACT.email, "0912345678", CONTACT.phone]) {
            expect(all).not.toContain(pii);
          }
          // Liên kết/token tra cứu (phát hành lúc gửi) không vào log.
          expect(all).not.toMatch(/xac-thuc|token=|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/);
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
