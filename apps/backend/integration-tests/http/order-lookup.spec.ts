import type { MedusaContainer } from "@medusajs/framework/types";
// Mặc định (không phải `* as`): spy phải gắn vào CHÍNH đối tượng module mà mã nguồn gọi, không phải bản sao namespace.
import nodeCrypto from "node:crypto";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import {
  setVnpayGatewayForTest,
  type QueryStatusResult,
  type VnpayGateway,
} from "../../src/lib/checkout/vnpay-gateway";
import { dispatchOutbox } from "../../src/lib/checkout/jobs";
import { parseEnv } from "../../src/lib/env";
import {
  setNotificationAdapterForTest,
  type NotificationAdapter,
  type OutgoingMessage,
} from "../../src/lib/notify/adapters";
import { currentLogContext } from "../../src/lib/log/logger";
import { issueOrderToken, ORDER_ACCESS_CONFIG, readOrderToken } from "../../src/lib/orders/access";
import { validateOutboxPayload } from "../../src/lib/outbox/payload";
import {
  DUMMY_LOOKUP_PHONE,
  lookupPortsFor,
  runOrderLookup,
  type LookupPorts,
} from "../../src/lib/orders/lookup";
import { ORDER_RATE_LIMITS } from "../../src/lib/orders/rate-limit";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { NOTIFY_MODULE } from "../../src/modules/notify";
import type NotifyModuleService from "../../src/modules/notify/service";
import { checkoutClient, CONTACT, DEV_VNPAY, ipn, type Api, type Res } from "../helpers/checkout-api";
import {
  createPromotion,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/**
 * Adapter thông báo chỉ bắt thư liên kết tra cứu của MỘT đơn (message key `notify:order.lookup_link:<order>:…`) — mọi
 * thư khác (kể cả do dispatcher nền gửi) bị bỏ qua. `failNext` > 0 → lần gửi đó ném lỗi tạm (SMTP 451) kèm nội dung
 * thư, mô phỏng thư có thể đã tới khách dù bên gửi báo lỗi.
 */
class LookupLinkCatcher implements NotificationAdapter {
  readonly name = "catcher";
  readonly live = false;
  failNext = 0;
  readonly seen: OutgoingMessage[] = [];
  constructor(private readonly orderId: string) {}
  async send(m: OutgoingMessage) {
    if (!m.messageKey.startsWith(`notify:order.lookup_link:${this.orderId}:`))
      return { providerMessageId: null };
    this.seen.push(m);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error(`SMTP 451 tạm lỗi — thư: ${m.text}`);
    }
    return { providerMessageId: `cat-${this.seen.length}` };
  }
}

/** Token trong liên kết của thư (null nếu không có). */
function linkTokenOf(m: OutgoingMessage): string | null {
  const match = /\/tra-cuu-don\/xac-thuc\?token=([^\s&]+)/.exec(m.text);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Dạng token ký HMAC (`base64url(body).base64url(mac)`) — không được xuất hiện trong bảng outbox. */
const TOKEN_SHAPE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

/** Gateway querydr lập trình được (mặc định "chưa trả"). */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    return (
      this.results.get(input.txnRef) ?? { outcome: "not_paid", transactionNo: null, reason: "status_01" }
    );
  }
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- thân JSON phản hồi không có kiểu; kiểm bằng expect từng trường
let ipSeq = 0;
/** Mỗi ca một IP giả (x-forwarded-for, Express `trust proxy` = 1) → bộ đếm theo IP không lẫn giữa các ca. */
const newIp = () => `10.21.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

/**
 * T-050: với cửa sổ CỐ ĐỊNH, ca đếm vắt qua ranh giới thì bộ đếm về 0 và lần "phải bị chặn" nhận 200. Từ T-055 bộ đếm
 * quyết định theo xấp xỉ cửa sổ trượt nên vắt qua ranh giới vẫn chặn đúng (ca hồi quy "sát ranh giới" bên dưới, đồng hồ
 * tiêm). Giữ hàm này cho các ca kiểm ngưỡng thường: tách khỏi phần dư của ca trước trong cửa sổ trước (cùng khoá) — không
 * còn cần cho tính đúng.
 */
async function alignToRateWindow(windowMs: number, needMs = 30_000): Promise<void> {
  const left = windowMs - (Date.now() % windowMs);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let gateway: ScriptedGateway;
    let ip: string;
    const client = checkoutClient(api, () => fx);
    const signer = new vnpay.MockVnpayGateway(DEV_VNPAY);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const cfg = (extra: Record<string, string> = {}) => client.cfg({ "x-forwarded-for": ip, ...extra });
    const withAccess = (token: string) => cfg({ "x-order-access": token });

    const getOrder = (ref: string, token?: string): Promise<Res<J>> =>
      api.get(`/store/x/orders/${ref}`, token === undefined ? cfg() : withAccess(token)) as Promise<Res<J>>;
    const cancel = (ref: string, token: string): Promise<Res<J>> =>
      api.post(`/store/x/orders/${ref}/cancel`, {}, withAccess(token)) as Promise<Res<J>>;
    const lookup = (body: unknown): Promise<Res<J>> =>
      api.post("/store/x/orders/lookup", body, cfg()) as Promise<Res<J>>;
    const session = (token: string): Promise<Res<J>> =>
      api.post("/store/x/orders/session", { token }, cfg()) as Promise<Res<J>>;

    /** Đặt đơn qua submit thật; trả cả token phiên đơn mà submit cấp. */
    async function place(items: Array<[string, number]>, method: "cod" | "vnpay", extra: object = {}) {
      const cartId = await client.createCart(items);
      const q = await client.quote(cartId, { payment_method: method, ...extra });
      const res = (await client.submit(q)) as unknown as Res<J>;
      if (res.status !== 200) throw new Error(`submit lỗi ${res.status}: ${JSON.stringify(res.data)}`);
      return {
        cartId,
        attemptId: res.data.checkout_attempt_id as string,
        orderId: res.data.order.id as string,
        ref: res.data.order.display_ref as string,
        total: res.data.order.total as number,
        paymentUrl: res.data.payment_url as string,
        access: res.data.order_access as string,
        accessExpiresAt: res.data.order_access_expires_at as string,
      };
    }

    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 50, "Đen/M": 50, "Trắng/S": 50, "Trắng/M": 50 },
      });
      gateway = new ScriptedGateway();
      setVnpayGatewayForTest(gateway);
      ip = newIp();
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setNotificationAdapterForTest(null);
    });
    afterEach(() => setNotificationAdapterForTest(null));

    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const nativeStatus = async (orderId: string) =>
      (await container.resolve(Modules.ORDER).retrieveOrder(orderId)).status;
    const lookupLinks = async (orderId: string) =>
      (await service().listOutboxEvents({ aggregate_id: orderId })).filter(
        (e) => e.type === "order.lookup_link",
      );
    type OutboxRow = Awaited<ReturnType<typeof lookupLinks>>[number];
    /**
     * Chạy dispatcher tới khi mọi sự kiện liên kết tra cứu của đơn thoả `done` (mặc định: rời `pending`). Dispatcher nền
     * (giờ thật) có thể nhận trước — không sao: adapter bắt thư là toàn cục, chỉ cần chờ trạng thái.
     */
    async function settleLookupLinks(
      orderId: string,
      opts: { now?: Date; done?: (e: OutboxRow) => boolean } = {},
    ): Promise<OutboxRow[]> {
      const done = opts.done ?? ((e: OutboxRow) => e.state !== "pending");
      for (let i = 0; i < 60; i++) {
        const events = await lookupLinks(orderId);
        if (events.length > 0 && events.every(done)) return events;
        await dispatchOutbox(container, opts.now ? { now: opts.now } : {});
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("sự kiện liên kết tra cứu không tới trạng thái mong đợi");
    }
    /** Tra cứu khớp → gửi thư qua outbox → token trong liên kết của thư. */
    async function lookupAndReceiveToken(o: { orderId: string; ref: string }): Promise<string> {
      const catcher = new LookupLinkCatcher(o.orderId);
      setNotificationAdapterForTest(catcher);
      expect((await lookup({ display_ref: o.ref, phone: CONTACT.phone })).status).toBe(202);
      await settleLookupLinks(o.orderId);
      expect(catcher.seen).toHaveLength(1);
      const token = linkTokenOf(catcher.seen[0]!);
      expect(token).toEqual(expect.any(String));
      return token!;
    }

    describe("phiên đơn từ submit + GET /store/x/orders/:ref", () => {
      it("submit cấp order_access; xem đơn tách 3 trạng thái, timeline, che SĐT, không lộ email; private no-store", async () => {
        const o = await place([["Đen/M", 2]], "cod");
        expect(o.access).toEqual(expect.any(String));
        expect(new Date(o.accessExpiresAt).getTime() - Date.now()).toBeGreaterThan(
          ORDER_ACCESS_CONFIG.accessTtlMs - 60_000,
        );
        // Token không nằm trong status_url/URL nào.
        const res = await getOrder(o.ref, o.access);
        expect(res.status).toBe(200);
        expect(res.headers["cache-control"]).toBe("private, no-store");
        expect(res.data).toMatchObject({
          display_ref: o.ref,
          state: "placed",
          payment_method: "cod",
          payment_state: "cod",
          shipment_state: "unfulfilled",
          hold_expires_at: null,
          cancel_reason: null,
          totals: { subtotal: 1_400_000, total: o.total, paid: 0 },
          address: {
            province_name: "Thành phố Hà Nội",
            ward_name: "Phường Ba Đình",
            line: "12 Phố Điện Biên Phủ",
          },
          contact: { name: CONTACT.name, phone: "0912***678" },
          actions: { can_cancel: true, can_recheck: false },
        });
        expect(res.data.lines).toEqual([
          expect.objectContaining({
            quantity: 2,
            unit_price: 700_000,
            total: 1_400_000,
            title: expect.any(String),
          }),
        ]);
        expect(res.data.timeline).toEqual([
          expect.objectContaining({ kind: "placed", at: expect.any(String) }),
        ]);
        const raw = JSON.stringify(res.data);
        expect(raw).not.toContain(CONTACT.email);
        expect(raw).not.toContain("0912345678");
        expect(raw).not.toContain(o.orderId);

        // Poll attempt (202 → GET attempts) cũng cấp token phiên đơn.
        const polled = (await api.get(
          `/store/x/checkout/attempts/${o.attemptId}?cart_id=${o.cartId}`,
          cfg(),
        )) as Res<J>;
        expect(polled.data.order_access).toEqual(expect.any(String));
        expect((await getOrder(o.ref, polled.data.order_access)).status).toBe(200);
      });

      it("[api1-bola get /store/x/orders/{display_ref}] AT20: thiếu/giả/hết hạn/sai loại token, token của đơn khác, mã không tồn tại → 404 giống nhau, không PII", async () => {
        const a = await place([["Đen/S", 1]], "cod");
        const b = await place([["Trắng/S", 1]], "cod");
        const forged = `${Buffer.from(`${a.orderId}.${Math.floor(Date.now() / 1000) + 3600}`).toString("base64url")}.AAAA`;
        const expired = issueOrderToken(
          "access",
          a.orderId,
          new Date(Date.now() - ORDER_ACCESS_CONFIG.accessTtlMs - 1000),
        );
        const linkAsAccess = issueOrderToken("link", a.orderId).token;
        const attempts: Array<[string, string | undefined]> = [
          [a.ref, undefined],
          [a.ref, ""],
          [a.ref, "rac"],
          [a.ref, forged],
          [a.ref, expired.token],
          [a.ref, linkAsAccess],
          [b.ref, a.access], // dò đơn khác bằng phiên hợp lệ của mình
          ["XS-ZZZZZZ", a.access],
          ["khong-phai-ma", a.access],
        ];
        const bodies = new Set<string>();
        for (const [ref, token] of attempts) {
          const r = await getOrder(ref, token);
          expect(r.status).toBe(404);
          expect(r.headers["cache-control"]).toContain("no-store");
          const raw = JSON.stringify(r.data);
          for (const pii of [CONTACT.name, CONTACT.email, "0912", "Điện Biên", b.orderId]) {
            expect(raw).not.toContain(pii);
          }
          // `trace_id` là mã ngẫu nhiên theo request (T-088) — không mang thông tin về đơn; phần còn lại phải giống hệt.
          const { trace_id: traceId, ...rest } = r.data as Record<string, unknown>;
          expect(typeof traceId).toBe("string");
          bodies.add(JSON.stringify(rest));
        }
        expect(bodies.size).toBe(1);
        // Hủy bằng token đơn khác cũng 404 và không đổi gì.
        expect((await cancel(b.ref, a.access)).status).toBe(404);
        expect((await fin(b.orderId)).state).toBe("placed");
        // Chủ đơn vẫn xem được.
        expect((await getOrder(b.ref, b.access)).status).toBe(200);
      });

      it("AT20: dò mã đơn — quá số lần bị từ chối theo IP → 429, IP khác không bị ảnh hưởng", async () => {
        const o = await place([["Đen/S", 1]], "cod");
        const limit = ORDER_RATE_LIMITS.deniedIp.limit;
        await alignToRateWindow(ORDER_RATE_LIMITS.deniedIp.windowMs);
        for (let i = 0; i < limit; i++) {
          const ref = `XS-${String(100000 + i).replace(/[01]/g, "A")}`;
          expect((await getOrder(ref, o.access)).status).toBe(404);
        }
        const blocked = await getOrder(o.ref, o.access);
        expect(blocked.status).toBe(429);
        expect(blocked.data.code).toBe("RATE_LIMITED");
        expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
        ip = newIp();
        expect((await getOrder(o.ref, o.access)).status).toBe(200);
      });

      it("hồi quy T-055: dò mã bắt đầu sát ranh giới cửa sổ — lần thứ N+1 (sau ranh giới) vẫn 429; hết cửa sổ trượt thì mở", async () => {
        const o = await place([["Đen/S", 1]], "cod");
        const { limit, windowMs } = ORDER_RATE_LIMITS.deniedIp;
        // Đồng hồ tiêm CHỈ cho bộ đếm (route vẫn dùng giờ thật cho token): N lần bị từ chối 50 ms trước ranh giới,
        // lần N+1 ngay sau ranh giới — cửa sổ cố định cũ đếm lại từ 0 ở đây và cho 200.
        const s = service();
        const realHit = s.hitRateCounter.bind(s);
        const realPeek = s.peekRateCounter.bind(s);
        const boundary = (Math.floor(Date.now() / windowMs) + 1) * windowMs;
        let clock = boundary - 50;
        const hit = jest
          .spyOn(s, "hitRateCounter")
          .mockImplementation((b, w) => realHit(b, w, new Date(clock)));
        const peek = jest
          .spyOn(s, "peekRateCounter")
          .mockImplementation((b, w) => realPeek(b, w, new Date(clock)));
        try {
          ip = newIp();
          for (let i = 0; i < limit; i++) {
            const ref = `XS-${String(200000 + i).replace(/[012]/g, "B")}`;
            expect((await getOrder(ref, o.access)).status).toBe(404);
          }
          clock = boundary + 10;
          const blocked = await getOrder(o.ref, o.access);
          expect(blocked.status).toBe(429);
          expect(blocked.data.code).toBe("RATE_LIMITED");
          // Retry-After: lần kế qua khi 1 + N·(M − e)/M ≤ N ⇔ e ≥ M/N.
          expect(Number(blocked.headers["retry-after"])).toBe(Math.ceil((windowMs / limit - 10) / 1000));
          clock = boundary + Math.ceil(windowMs / limit);
          expect((await getOrder(o.ref, o.access)).status).toBe(200);
        } finally {
          hit.mockRestore();
          peek.mockRestore();
        }
      });

      it("VNPAY_RETURN_URL kèm attempt = checkout attempt của lần đặt (đã ký); mỗi lần đặt một attempt riêng", async () => {
        const a = await place([["Đen/M", 1]], "vnpay");
        const b = await place([["Trắng/M", 1]], "vnpay");
        const returnOf = (paymentUrl: string) =>
          new URL(new URL(paymentUrl).searchParams.get("vnp_ReturnUrl") as string);
        const ra = returnOf(a.paymentUrl);
        expect(ra.pathname).toBe("/thanh-toan/ket-qua");
        expect(ra.searchParams.get("attempt")).toBe(a.attemptId);
        expect(returnOf(b.paymentUrl).searchParams.get("attempt")).toBe(b.attemptId);
        expect(a.attemptId).not.toBe(b.attemptId);
        // URL lưu ở payment attempt là bản đã ký có attempt (không token, không PII).
        const [pa] = await service().listPaymentAttempts({ order_id: a.orderId });
        expect(pa?.payment_url).toBe(a.paymentUrl);
        expect(a.paymentUrl).not.toContain(a.access);
        // SĐT đầy đủ/che/không số 0 đầu — không dò "0912" trần: vnp_ExpireDate (yyyyMMddHHmmss) có thể chứa nó theo giờ chạy.
        expect(decodeURIComponent(a.paymentUrl)).not.toMatch(/0?912345678|0912\*+678|an@example/);
      });

      it("AT08/AT24: tham số return 'thành công' trên URL không đổi trạng thái; recheck hỏi cổng cùng giao dịch", async () => {
        const o = await place([["Trắng/M", 1]], "vnpay");
        const fake = signer.pay(o.paymentUrl, "success");
        const viaReturn = (await api.get(
          `/store/x/orders/${o.ref}?${fake.toString()}`,
          withAccess(o.access),
        )) as Res<J>;
        expect(viaReturn.status).toBe(200);
        expect(viaReturn.data).toMatchObject({
          state: "awaiting_payment",
          payment_state: "pending",
          actions: { can_recheck: true, can_cancel: true },
          totals: { paid: 0 },
        });
        expect(viaReturn.data.hold_expires_at).toEqual(expect.any(String));
        expect(await service().listPaymentLedgers({ order_id: o.orderId })).toHaveLength(0);

        // Recheck: cổng nói chưa trả → không đổi; lần 2 trong 10 giây → 429; không tạo payment attempt mới.
        const re = (await api.post(`/store/x/orders/${o.ref}/recheck`, {}, withAccess(o.access))) as Res<J>;
        expect(re.status).toBe(200);
        expect(re.headers["cache-control"]).toBe("private, no-store");
        expect(re.data).toMatchObject({
          payment_check: "not_paid",
          state: "awaiting_payment",
          payment_state: "pending",
        });
        const again = (await api.post(
          `/store/x/orders/${o.ref}/recheck`,
          {},
          withAccess(o.access),
        )) as Res<J>;
        expect(again.status).toBe(429);
        expect(await service().listPaymentAttempts({ order_id: o.orderId })).toHaveLength(1);
        // Recheck không có token → 404.
        expect((await api.post(`/store/x/orders/${o.ref}/recheck`, {}, cfg())).status).toBe(404);
      });

      it("recheck: cổng báo đã trả → confirmed + paid đúng một khoản thu (cùng đường IPN)", async () => {
        const o = await place([["Đen/S", 1]], "vnpay");
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        gateway.results.set(pa!.txn_ref, { outcome: "paid", transactionNo: "21000001", reason: "status_00" });
        const re = (await api.post(`/store/x/orders/${o.ref}/recheck`, {}, withAccess(o.access))) as Res<J>;
        expect(re.data).toMatchObject({ payment_check: "paid", state: "confirmed", payment_state: "paid" });
        expect(re.data.totals.paid).toBe(o.total);
        expect(re.data.timeline.map((t: J) => t.kind)).toEqual(
          expect.arrayContaining(["placed", "payment_captured", "confirmed"]),
        );
        expect(await service().listPaymentLedgers({ order_id: o.orderId })).toHaveLength(1);
        // Đã thanh toán → không còn nút kiểm tra lại.
        expect(re.data.actions.can_recheck).toBe(false);
      });
    });

    describe("POST /store/x/orders/lookup + /session", () => {
      it("luôn 202 cùng thông điệp; chỉ khớp mã + SĐT mới tạo liên kết (outbox), token không có trong phản hồi", async () => {
        const o = await place([["Đen/M", 1]], "cod");
        const ok = await lookup({ display_ref: o.ref.toLowerCase(), phone: "+84 912 345 678" });
        const wrongPhone = await lookup({ display_ref: o.ref, phone: "0987654321" });
        const noOrder = await lookup({ display_ref: "XS-ZZZZZZ", phone: "0912345678" });
        for (const r of [ok, wrongPhone, noOrder]) {
          expect(r.status).toBe(202);
          expect(r.headers["cache-control"]).toBe("private, no-store");
          expect(r.data).toEqual(ok.data);
        }
        const links = await lookupLinks(o.orderId);
        expect(links).toHaveLength(1);
        // T-149 (D-089): payload chỉ có ID — token phát hành lúc gửi, không nằm trong outbox cũng như phản hồi.
        expect(links[0]!.payload).toEqual({ order_id: o.orderId, display_ref: o.ref });
        expect(JSON.stringify(ok.data)).not.toMatch(TOKEN_SHAPE);

        // Định dạng sai → 422 (không chạm DB, không lộ tồn tại).
        expect((await lookup({ display_ref: "abc", phone: "0912345678" })).status).toBe(422);
        expect((await lookup({ display_ref: o.ref, phone: "123" })).status).toBe(422);
        expect((await lookup({ display_ref: o.ref })).status).toBe(422);
      });

      it("[api1-bola post /store/x/orders/lookup] đồng đều: không có đơn / sai SĐT / đơn thiếu SĐT chạy CÙNG các bước, cùng thứ tự; khớp chỉ thêm bước gửi", async () => {
        const o = await place([["Đen/S", 1]], "cod");
        const real = lookupPortsFor(container);
        const steps: string[] = [];
        const compared: Array<[string, string]> = [];
        const recording: LookupPorts = {
          findByRef: async (ref) => {
            steps.push("findByRef");
            return real.findByRef(ref);
          },
          phoneEquals: (stored, given) => {
            steps.push("phoneEquals");
            compared.push([stored, given]);
            return real.phoneEquals(stored, given);
          },
          deliverLink: async (c) => {
            steps.push("deliverLink");
            return real.deliverLink(c);
          },
        };
        const run = async (ref: string, phone: string) => {
          steps.length = 0;
          compared.length = 0;
          const matched = await runOrderLookup(recording, ref, phone);
          return { matched, steps: [...steps], compared: [...compared] };
        };

        const notFound = await run("XS-ZZZZZZ", "0912345678");
        const wrongPhone = await run(o.ref, "0987654321");
        expect(notFound).toEqual({
          matched: false,
          // T-149: không còn bước ký — token phát hành lúc gửi (bộ xử lý thông báo), không ở tra cứu.
          steps: ["findByRef", "phoneEquals"],
          // Không có đơn → vẫn so sánh băm với giá trị giả (không short-circuit).
          compared: [[DUMMY_LOOKUP_PHONE, "0912345678"]],
        });
        expect(wrongPhone.matched).toBe(false);
        expect(wrongPhone.steps).toEqual(notFound.steps);
        expect(await lookupLinks(o.orderId)).toHaveLength(0);

        // Ca biên: đơn có thật nhưng snapshot liên hệ thiếu SĐT → không khớp, cùng các bước.
        const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        const other = await place([["Trắng/S", 1]], "cod");
        await pg.raw(`UPDATE order_finance SET contact = contact - 'phone' WHERE order_id = ?`, [
          other.orderId,
        ]);
        const noPhone = await run(other.ref, "0912345678");
        expect(noPhone).toEqual({ ...notFound, compared: [["", "0912345678"]] });
        expect(await lookupLinks(other.orderId)).toHaveLength(0);

        // Khớp: cùng các bước + đúng một bước gửi liên kết.
        const match = await run(o.ref, "0912345678");
        expect(match.matched).toBe(true);
        expect(match.steps).toEqual([...notFound.steps, "deliverLink"]);
        expect(await lookupLinks(o.orderId)).toHaveLength(1);
      });

      it("đồng đều qua HTTP: không có đơn và sai SĐT → cùng số truy vấn, so sánh hằng thời gian, số lần HMAC; không outbox; cùng phản hồi", async () => {
        const o = await place([["Trắng/M", 1]], "cod");
        const s = service();
        // Spy gắn trên service/`node:crypto` dùng chung cả tiến trình: job nền (outbox-dispatch mỗi 10 s đọc
        // `listOrderFinances({ order_id })` + `hitRateCounter("breaker.budget:…")` cho sự kiện `order.placed_pending` của
        // chính đơn vừa đặt) chạy chồng lên request thì đếm lẫn → CI 24d227c nhận `find: 2`. Chỉ đếm lời gọi nằm TRONG
        // ngữ cảnh của request đang đo: middleware `requestLogContext` mở AsyncLocalStorage với `trace_id` = `x-request-id`
        // (lib/log/http.ts); lời gọi ngoài request (job, test) không mang `trace_id` đó. Ngữ cảnh mất → đếm 0 → `find: 1` đỏ.
        let traceSeq = 0;
        let measuring: string | null = null;
        const scopedCounter = <T extends object>(target: T, method: keyof T & string) => {
          const host = target as unknown as Record<string, (...args: unknown[]) => unknown>;
          const original = host[method]!;
          const counter = { inRequest: 0, outside: 0 };
          const spy = jest.spyOn(host, method).mockImplementation(function (
            this: unknown,
            ...args: unknown[]
          ) {
            if (measuring !== null && currentLogContext()?.trace_id === measuring) counter.inRequest += 1;
            else counter.outside += 1;
            return original.apply(this, args);
          });
          return { counter, spy };
        };
        const spies = {
          find: scopedCounter(s, "listOrderFinances"),
          rate: scopedCounter(s, "hitRateCounter"),
          outbox: scopedCounter(s, "insertOutbox"),
          // So sánh hằng thời gian: không có đơn vẫn phải so (giá trị giả) như khi sai SĐT. HMAC: hai nhánh cùng số lần
          // (T-149 bỏ bước ký token ở tra cứu — có thể là 0).
          compare: scopedCounter(nodeCrypto, "timingSafeEqual"),
          hmac: scopedCounter(nodeCrypto, "createHmac"),
        };
        const outsideCalls = () => Object.values(spies).reduce((n, x) => n + x.counter.outside, 0);
        const counted = async (body: unknown, alongside: () => Promise<unknown> = async () => undefined) => {
          for (const { counter } of Object.values(spies))
            Object.assign(counter, { inRequest: 0, outside: 0 });
          const traceId = `lookup-uniform-${process.pid}-${++traceSeq}`;
          measuring = traceId;
          try {
            const [r] = await Promise.all([
              api.post("/store/x/orders/lookup", body, cfg({ "x-request-id": traceId })) as Promise<Res<J>>,
              alongside(),
            ]);
            return {
              status: r.status,
              body: JSON.stringify(r.data),
              find: spies.find.counter.inRequest,
              rate: spies.rate.counter.inRequest,
              outbox: spies.outbox.counter.inRequest,
              compare: spies.compare.counter.inRequest,
              hmac: spies.hmac.counter.inRequest,
            };
          } finally {
            measuring = null;
          }
        };
        try {
          const notFound = await counted({ display_ref: "XS-ZZZZZZ", phone: CONTACT.phone });
          const wrongPhone = await counted({ display_ref: o.ref, phone: "0987654321" });
          expect(notFound).toMatchObject({ status: 202, find: 1, rate: 3, outbox: 0 });
          expect(notFound.compare).toBeGreaterThanOrEqual(1);
          expect(wrongPhone).toEqual(notFound);
          const ok = await counted({ display_ref: o.ref, phone: CONTACT.phone });
          expect(ok).toMatchObject({ ...notFound, outbox: 1, hmac: expect.any(Number) });

          // Hồi quy (CI 24d227c): việc ngoài request chạy CHỒNG lên request đang đo — đúng các lời gọi job nền làm
          // (đọc đơn theo order_id, đếm ngân sách breaker) cộng so sánh/HMAC — không được lọt vào số đếm của request.
          const noise = async () => {
            await s.listOrderFinances({ order_id: o.orderId });
            await s.hitRateCounter("test.noise:lookup-uniform", 60_000, new Date());
            nodeCrypto.timingSafeEqual(Buffer.alloc(4), Buffer.alloc(4));
            nodeCrypto.createHmac("sha256", "noise").update("x").digest();
          };
          const underNoise = await counted({ display_ref: "XS-YYYYYY", phone: "0911222333" }, noise);
          expect(underNoise).toEqual(notFound);
          expect(outsideCalls()).toBeGreaterThanOrEqual(4); // việc chồng thật sự đã chạy trong cửa sổ đo
        } finally {
          for (const { spy } of Object.values(spies)) spy.mockRestore();
        }
      });

      it("rate limit: SĐT 5/giờ → lần 6 bị 429 kể cả khi khớp; IP khác vẫn bị chặn theo SĐT", async () => {
        const o = await place([["Đen/M", 1]], "cod");
        await alignToRateWindow(ORDER_RATE_LIMITS.lookupPhone.windowMs);
        for (let i = 0; i < ORDER_RATE_LIMITS.lookupPhone.limit; i++) {
          expect((await lookup({ display_ref: "XS-ZZZZZZ", phone: "0912345678" })).status).toBe(202);
        }
        ip = newIp();
        const blocked = await lookup({ display_ref: o.ref, phone: "0912345678" });
        expect(blocked.status).toBe(429);
        expect(blocked.data.code).toBe("RATE_LIMITED");
        expect(await lookupLinks(o.orderId)).toHaveLength(0);
      });

      it("hồi quy T-055: SĐT tra cứu bắt đầu sát ranh giới — lần thứ 6 ngay sau ranh giới vẫn 429 (đồng hồ tiêm)", async () => {
        const o = await place([["Đen/M", 1]], "cod");
        const { limit, windowMs } = ORDER_RATE_LIMITS.lookupPhone;
        const s = service();
        const realHit = s.hitRateCounter.bind(s);
        const boundary = (Math.floor(Date.now() / windowMs) + 1) * windowMs;
        let clock = boundary - 1;
        const hit = jest
          .spyOn(s, "hitRateCounter")
          .mockImplementation((b, w) => realHit(b, w, new Date(clock)));
        try {
          const phone = "0933 222 111";
          for (let i = 0; i < limit; i++) {
            ip = newIp();
            expect((await lookup({ display_ref: "XS-QQQQQQ", phone })).status).toBe(202);
          }
          clock = boundary;
          ip = newIp();
          const blocked = await lookup({ display_ref: o.ref, phone });
          expect(blocked.status).toBe(429);
          expect(blocked.data.code).toBe("RATE_LIMITED");
          // Lần kế qua khi 1 + 1 + 5·(M − e)/M ≤ 5 ⇔ e ≥ 2M/5 (cửa sổ cố định cũ: 200 ngay tại đây).
          expect(Number(blocked.headers["retry-after"])).toBe(Math.ceil((2 * windowMs) / 5 / 1000));
          expect(await lookupLinks(o.orderId)).toHaveLength(0);
        } finally {
          hit.mockRestore();
        }
      });

      it("[api1-bola post /store/x/orders/session] đổi liên kết → phiên đơn; dùng lại/giả/hết hạn/sai loại → 404; hai lần đổi đồng thời chỉ một thành công", async () => {
        const o = await place([["Trắng/S", 1]], "cod");
        const token = await lookupAndReceiveToken(o);

        const [r1, r2] = await Promise.all([session(token), session(token)]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses).toEqual([200, 404]);
        const won = r1.status === 200 ? r1 : r2;
        expect(won.headers["cache-control"]).toBe("private, no-store");
        expect(won.data).toMatchObject({ display_ref: o.ref, order_access: expect.any(String) });
        expect((await getOrder(o.ref, won.data.order_access)).status).toBe(200);
        expect((await session(token)).status).toBe(404);

        const expired = issueOrderToken(
          "link",
          o.orderId,
          new Date(Date.now() - ORDER_ACCESS_CONFIG.linkTtlMs - 1000),
        );
        for (const bad of [expired.token, o.access, "rac.rac", `${token}x`]) {
          const r = await session(bad);
          expect(r.status).toBe(404);
          expect(JSON.stringify(r.data)).not.toContain(o.ref);
        }
      });
    });

    describe("T-149 (D-089, BE-JOB-007) — thư liên kết tra cứu qua outbox: token phát hành lúc gửi", () => {
      it("tra cứu khớp → outbox chỉ có ID (không token/link/bí mật) → gửi thành công, liên kết trỏ storefront, token đổi được phiên đơn", async () => {
        const o = await place([["Đen/M", 1]], "cod");
        const catcher = new LookupLinkCatcher(o.orderId);
        setNotificationAdapterForTest(catcher);
        expect((await lookup({ display_ref: o.ref, phone: CONTACT.phone })).status).toBe(202);

        const [before] = await lookupLinks(o.orderId);
        expect(before!.payload).toEqual({ order_id: o.orderId, display_ref: o.ref });
        expect(validateOutboxPayload(before!.type, before!.payload)).toEqual({ ok: true });

        const [ev] = await settleLookupLinks(o.orderId);
        expect(ev).toMatchObject({ state: "sent", attempts: 0 });
        expect(catcher.seen).toHaveLength(1);
        const m = catcher.seen[0]!;
        expect(m).toMatchObject({ template: "order.lookup_link", channel: "email", to: CONTACT.email });
        expect(m.messageKey).toBe(`notify:${ev!.event_key}:email`);
        const env = parseEnv(process.env);
        if (!env.ok) throw new Error("env test không hợp lệ");
        const base = env.env.storefrontUrl;
        expect(base).toMatch(/^https?:\/\/[^/]+/);
        const token = linkTokenOf(m)!;
        expect(m.text).toContain(`${base}/tra-cuu-don/xac-thuc?token=${encodeURIComponent(token)}`);
        const claim = readOrderToken("link", token);
        expect(claim?.orderId).toBe(o.orderId);
        // Hạn 15 phút tính từ LÚC GỬI.
        expect(claim!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
          ORDER_ACCESS_CONFIG.linkTtlMs - 60_000,
        );

        // Liên kết dùng được: đổi phiên đơn → xem đơn.
        const s = await session(token);
        expect(s.status).toBe(200);
        expect(s.data.display_ref).toBe(o.ref);
        expect((await getOrder(o.ref, s.data.order_access)).status).toBe(200);

        // Sau khi gửi, bảng outbox (payload, lỗi) và bản ghi gửi vẫn không chứa token/bí mật nào.
        const [after] = await lookupLinks(o.orderId);
        const stored = JSON.stringify({ payload: after!.payload, last_error: after!.last_error });
        expect(stored).not.toContain(token);
        expect(stored).not.toMatch(TOKEN_SHAPE);
        expect(stored).not.toMatch(/token|link|secret|xac-thuc/i);
        const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        const { rows } = await pg.raw(
          `SELECT payload::text AS p FROM outbox_event WHERE type = 'order.lookup_link'`,
        );
        for (const r of rows as Array<{ p: string }>) expect(r.p).not.toMatch(TOKEN_SHAPE);
      });

      it("gửi trễ (đồng hồ dispatcher tiêm): hạn 15 phút tính từ LÚC GỬI, không phải lúc tra cứu", async () => {
        const o = await place([["Trắng/S", 1]], "cod");
        const catcher = new LookupLinkCatcher(o.orderId);
        setNotificationAdapterForTest(catcher);
        // Sự kiện hẹn ở tương lai (dispatcher nền giờ thật không nhận) — mô phỏng hàng đợi kẹt 40 phút.
        const sendAt = new Date(Date.now() + 40 * 60_000);
        const s = service();
        const realInsert = s.insertOutbox.bind(s);
        const spy = jest
          .spyOn(s, "insertOutbox")
          .mockImplementation((key, agg, type, payload, em) =>
            realInsert(key, agg, type, payload, em, sendAt),
          );
        const requestedAt = Date.now();
        try {
          expect((await lookup({ display_ref: o.ref, phone: CONTACT.phone })).status).toBe(202);
        } finally {
          spy.mockRestore();
        }
        const [ev] = await settleLookupLinks(o.orderId, { now: sendAt });
        expect(ev).toMatchObject({ state: "sent", attempts: 0 });
        expect(catcher.seen).toHaveLength(1);
        const token = linkTokenOf(catcher.seen[0]!)!;
        const ttl = ORDER_ACCESS_CONFIG.linkTtlMs;
        const claim = readOrderToken("link", token, sendAt);
        expect(claim?.orderId).toBe(o.orderId);
        // Hạn = lúc gửi + 15 phút (token tính theo giây).
        expect(claim!.expiresAt.getTime()).toBe(Math.floor((sendAt.getTime() + ttl) / 1000) * 1000);
        // Nếu hạn tính từ lúc tra cứu thì thư tới nơi đã hết hạn.
        expect(claim!.expiresAt.getTime()).toBeGreaterThan(requestedAt + ttl);
        expect(readOrderToken("link", token, new Date(sendAt.getTime() + ttl - 2_000))).not.toBeNull();
        expect(readOrderToken("link", token, new Date(sendAt.getTime() + ttl + 1_000))).toBeNull();
      });

      it("retry: lần gửi đầu lỗi (thư có thể đã tới) → lần sau phát token MỚI; mỗi token chỉ mở đúng đơn đó, một lần, không thay được token phiên", async () => {
        const o = await place([["Trắng/M", 1]], "cod");
        const other = await place([["Đen/S", 1]], "cod");
        const catcher = new LookupLinkCatcher(o.orderId);
        catcher.failNext = 1;
        setNotificationAdapterForTest(catcher);
        expect((await lookup({ display_ref: o.ref, phone: CONTACT.phone })).status).toBe(202);

        const [failed] = await settleLookupLinks(o.orderId);
        expect(failed).toMatchObject({ state: "failed", attempts: 1 });
        expect(catcher.seen).toHaveLength(1);
        const t1 = linkTokenOf(catcher.seen[0]!)!;
        // Lỗi ghi lại đã che token (thông điệp lỗi của adapter chứa nguyên thư).
        expect(failed!.last_error).toContain("SMTP 451");
        expect(failed!.last_error).not.toContain(t1);
        expect(failed!.last_error).not.toMatch(TOKEN_SHAPE);

        // Token tất định theo (đơn, giây hết hạn) — chờ qua giây để lần retry phát token khác hẳn.
        await new Promise((r) => setTimeout(r, 1_100));
        const [sent] = await settleLookupLinks(o.orderId, {
          now: new Date(failed!.next_attempt_at),
          done: (e) => e.state === "sent",
        });
        expect(sent).toMatchObject({ state: "sent", attempts: 1 });
        expect(catcher.seen).toHaveLength(2);
        expect(catcher.seen[1]!.messageKey).toBe(catcher.seen[0]!.messageKey);
        const t2 = linkTokenOf(catcher.seen[1]!)!;
        expect(t2).not.toBe(t1);
        expect(JSON.stringify(sent!.payload)).not.toMatch(TOKEN_SHAPE);

        // Không mở rộng quyền: cả hai token cùng loại `link`, cùng đơn, không dùng được làm token phiên.
        for (const t of [t1, t2]) {
          expect(readOrderToken("link", t)?.orderId).toBe(o.orderId);
          expect(readOrderToken("access", t)).toBeNull();
          expect((await getOrder(o.ref, t)).status).toBe(404);
        }
        const s1 = await session(t1);
        const s2 = await session(t2);
        for (const s of [s1, s2]) {
          expect(s.status).toBe(200);
          expect(s.data.display_ref).toBe(o.ref);
          expect((await getOrder(o.ref, s.data.order_access)).status).toBe(200);
          // Phiên đổi từ token nào cũng chỉ xem được đúng đơn đó.
          expect((await getOrder(other.ref, s.data.order_access)).status).toBe(404);
        }
        // Mỗi token một lần.
        expect((await session(t1)).status).toBe(404);
        expect((await session(t2)).status).toBe(404);
        const [msg] = await container
          .resolve<NotifyModuleService>(NOTIFY_MODULE)
          .listOutboundMessages({ message_key: catcher.seen[0]!.messageKey });
        expect(msg).toMatchObject({ state: "sent", attempts: 2 });
      });

      it("đồng thời: hai lần tra cứu khớp cùng lúc → hai sự kiện riêng; hai dispatcher song song gửi mỗi sự kiện đúng một lần", async () => {
        const o = await place([["Đen/S", 1]], "cod");
        const catcher = new LookupLinkCatcher(o.orderId);
        setNotificationAdapterForTest(catcher);
        const rs = await Promise.all([
          lookup({ display_ref: o.ref, phone: CONTACT.phone }),
          lookup({ display_ref: o.ref, phone: "+84912345678" }),
        ]);
        for (const r of rs) expect(r.status).toBe(202);
        const events = await lookupLinks(o.orderId);
        expect(events).toHaveLength(2);
        expect(new Set(events.map((e) => e.event_key)).size).toBe(2);
        for (const e of events) expect(e.payload).toEqual({ order_id: o.orderId, display_ref: o.ref });

        await Promise.all([dispatchOutbox(container), dispatchOutbox(container)]);
        const settled = await settleLookupLinks(o.orderId);
        for (const e of settled) expect(e.state).toBe("sent");
        expect(catcher.seen).toHaveLength(2);
        expect(new Set(catcher.seen.map((m) => m.messageKey)).size).toBe(2);
        for (const m of catcher.seen) expect(readOrderToken("link", linkTokenOf(m))?.orderId).toBe(o.orderId);
      });
    });

    describe("POST /store/x/orders/:ref/cancel (POST02)", () => {
      it("COD placed: hủy native, nhả reservation, mã released; gọi lại/đồng thời idempotent (một sự kiện hủy)", async () => {
        await createPromotion(container, "HUYDON", { limit: 5, percent: 10 });
        const o = await place([["Đen/M", 2]], "cod", { discount_code: "HUYDON" });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 2 });

        const [c1, c2] = await Promise.all([cancel(o.ref, o.access), cancel(o.ref, o.access)]);
        expect([c1.status, c2.status]).toEqual([200, 200]);
        expect([c1.data.cancel.outcome, c2.data.cancel.outcome].sort()).toEqual([
          "already_cancelled",
          "cancelled",
        ]);
        expect(c1.data).toMatchObject({
          state: "cancelled",
          payment_state: "void",
          cancel_reason: "CUSTOMER_CANCELLED",
          actions: { can_cancel: false },
        });
        expect(c1.headers["cache-control"]).toBe("private, no-store");
        expect(await nativeStatus(o.orderId)).toBe("canceled");
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
        expect((await service().listCouponUsages({ promotion_code: "HUYDON" })).map((u) => u.state)).toEqual([
          "released",
        ]);
        const [attempt] = await service().listCheckoutAttempts({ id: o.attemptId });
        expect(attempt).toMatchObject({ state: "failed", error_code: "CUSTOMER_CANCELLED" });
        const events = (await service().listOutboxEvents({ aggregate_id: o.orderId })).filter(
          (e) => e.type === "order.cancelled",
        );
        expect(events).toHaveLength(1);

        const again = await cancel(o.ref, o.access);
        expect(again.status).toBe(200);
        expect(again.data.cancel).toEqual({ outcome: "already_cancelled", refund_requested: false });
        expect(
          await service().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" }),
        ).toHaveLength(0);
      });

      // S-309 (SPEC-fulfillment): hủy đơn đã trả tiền → mở hoàn tiền; xem thêm staff-cancel.spec.ts.
      it("đơn đã thanh toán: hủy → yêu cầu hoàn tiền (một lần), nhả reservation, KHÔNG ghi hoàn native giả", async () => {
        const o = await place([["Trắng/M", 1]], "vnpay");
        expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).status).toBe(200);
        expect((await fin(o.orderId)).state).toBe("confirmed");

        const c = await cancel(o.ref, o.access);
        expect(c.status).toBe(200);
        expect(c.data).toMatchObject({
          state: "cancelled",
          payment_state: "refund_pending",
          cancel: { outcome: "cancelled", refund_requested: true },
          totals: { paid: o.total },
        });
        expect(c.data.timeline.map((t: J) => t.kind)).toEqual(
          expect.arrayContaining(["payment_captured", "cancelled", "refund_requested"]),
        );
        const refunds = await service().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" });
        expect(refunds.map((r) => [r.amount, r.state, r.priority])).toEqual([[o.total, "open", "high"]]);
        expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(0);
        // Đơn native giữ nguyên (hủy + hoàn thật ở T-027), không có refund native.
        expect(await nativeStatus(o.orderId)).not.toBe("canceled");
        const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        const refundRows = await pg.raw(
          `SELECT r.id FROM refund r JOIN payment p ON p.id = r.payment_id
           JOIN order_payment_collection opc ON opc.payment_collection_id = p.payment_collection_id
           WHERE opc.order_id = ?`,
          [o.orderId],
        );
        expect(refundRows.rows).toHaveLength(0);
        // Gọi lại → không mở thêm yêu cầu hoàn.
        expect((await cancel(o.ref, o.access)).data.cancel).toEqual({
          outcome: "already_cancelled",
          refund_requested: true,
        });
        expect(
          await service().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" }),
        ).toHaveLength(1);
      });

      it("đang chờ thanh toán: cổng chưa rõ → 409 PAYMENT_PENDING (không hủy); chưa trả → hủy, payment attempt failed", async () => {
        const o = await place([["Đen/S", 1]], "vnpay");
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        gateway.results.set(pa!.txn_ref, { outcome: "unknown", transactionNo: null, reason: "timeout" });
        const pending = await cancel(o.ref, o.access);
        expect(pending.status).toBe(409);
        expect(pending.data.code).toBe("PAYMENT_PENDING");
        expect((await fin(o.orderId)).state).toBe("awaiting_payment");

        gateway.results.delete(pa!.txn_ref);
        const c = await cancel(o.ref, o.access);
        expect(c.status).toBe(200);
        expect(c.data).toMatchObject({ state: "cancelled", payment_state: "void" });
        expect((await service().listPaymentAttempts({ order_id: o.orderId })).map((p) => p.state)).toEqual([
          "failed",
        ]);
        expect(await nativeStatus(o.orderId)).toBe("canceled");
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(0);
      });

      it("trạng thái không cho phép (đã hoàn tất) → 409 NOT_CANCELLABLE, không đổi gì", async () => {
        const o = await place([["Trắng/S", 1]], "cod");
        await container
          .resolve(ContainerRegistrationKeys.PG_CONNECTION)
          .raw(`UPDATE order_finance SET state = 'completed' WHERE order_id = ?`, [o.orderId]);
        const r = await cancel(o.ref, o.access);
        expect(r.status).toBe(409);
        expect(r.data.code).toBe("NOT_CANCELLABLE");
        expect((await fin(o.orderId)).state).toBe("completed");
        expect(await nativeStatus(o.orderId)).not.toBe("canceled");
        expect((await getOrder(o.ref, o.access)).data.actions.can_cancel).toBe(false);
      });
    });
  },
});
