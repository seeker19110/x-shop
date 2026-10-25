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
import { issueOrderToken, ORDER_ACCESS_CONFIG } from "../../src/lib/orders/access";
import {
  DUMMY_LOOKUP_PHONE,
  lookupPortsFor,
  runOrderLookup,
  type LookupPorts,
} from "../../src/lib/orders/lookup";
import { ORDER_RATE_LIMITS } from "../../src/lib/orders/rate-limit";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { checkoutClient, CONTACT, DEV_VNPAY, ipn, type Api, type Res } from "../helpers/checkout-api";
import {
  createPromotion,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/** Gateway querydr lập trình được (mặc định "chưa trả"). */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    return (
      this.results.get(input.txnRef) ?? { outcome: "not_paid", transactionNo: null, reason: "status_01" }
    );
  }
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let ipSeq = 0;
/** Mỗi ca một IP giả (x-forwarded-for, Express `trust proxy` = 1) → bộ đếm theo IP không lẫn giữa các ca. */
const newIp = () => `10.21.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

/**
 * Bộ đếm là cửa sổ CỐ ĐỊNH theo đồng hồ (bội của windowMs từ epoch): ca đếm vắt qua ranh giới thì bộ đếm về 0 và lần "phải
 * bị chặn" nhận 200 (T-050: tái hiện được khi bắt đầu ca cách ranh giới ~60 ms). Ca kiểm ngưỡng gọi hàm này TRƯỚC khi
 * đếm: cửa sổ chứa "bây giờ" còn ít hơn `needMs` thì đợi sang cửa sổ mới — tất định, không nới ngưỡng, không đổi mã chạy
 * thật (cửa sổ cố định là thiết kế đã chọn).
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
    afterAll(() => setVnpayGatewayForTest(null));

    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const nativeStatus = async (orderId: string) =>
      (await container.resolve(Modules.ORDER).retrieveOrder(orderId)).status;
    const lookupLinks = async (orderId: string) =>
      (await service().listOutboxEvents({ aggregate_id: orderId })).filter(
        (e) => e.type === "order.lookup_link",
      );

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

      it("AT20: thiếu/giả/hết hạn/sai loại token, token của đơn khác, mã không tồn tại → 404 giống nhau, không PII", async () => {
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
          bodies.add(raw);
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
        expect(decodeURIComponent(a.paymentUrl)).not.toMatch(/0912|an@example/);
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
        const token = String(links[0]!.payload.token);
        expect(JSON.stringify(ok.data)).not.toContain(token);
        expect(links[0]!.payload).toMatchObject({ display_ref: o.ref, expires_at: expect.any(String) });

        // Định dạng sai → 422 (không chạm DB, không lộ tồn tại).
        expect((await lookup({ display_ref: "abc", phone: "0912345678" })).status).toBe(422);
        expect((await lookup({ display_ref: o.ref, phone: "123" })).status).toBe(422);
        expect((await lookup({ display_ref: o.ref })).status).toBe(422);
      });

      it("đồng đều: không có đơn / sai SĐT / đơn thiếu SĐT chạy CÙNG các bước, cùng thứ tự; khớp chỉ thêm bước gửi", async () => {
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
          issueLink: (orderId, now) => {
            steps.push("issueLink");
            return real.issueLink(orderId, now);
          },
          deliverLink: async (c, link) => {
            steps.push("deliverLink");
            return real.deliverLink(c, link);
          },
        };
        const run = async (ref: string, phone: string) => {
          steps.length = 0;
          compared.length = 0;
          const matched = await runOrderLookup(recording, ref, phone, new Date());
          return { matched, steps: [...steps], compared: [...compared] };
        };

        const notFound = await run("XS-ZZZZZZ", "0912345678");
        const wrongPhone = await run(o.ref, "0987654321");
        expect(notFound).toEqual({
          matched: false,
          steps: ["findByRef", "phoneEquals", "issueLink"],
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

      it("đồng đều qua HTTP: không có đơn và sai SĐT → cùng số truy vấn, so sánh hằng thời gian, lần ký HMAC; không outbox; cùng phản hồi", async () => {
        const o = await place([["Trắng/M", 1]], "cod");
        const s = service();
        const spies = {
          find: jest.spyOn(s, "listOrderFinances"),
          rate: jest.spyOn(s, "hitRateCounter"),
          outbox: jest.spyOn(s, "insertOutbox"),
          // So sánh hằng thời gian + ký HMAC: không có đơn vẫn phải so (giá trị giả) và ký như khi sai SĐT.
          compare: jest.spyOn(nodeCrypto, "timingSafeEqual"),
          hmac: jest.spyOn(nodeCrypto, "createHmac"),
        };
        const counted = async (body: unknown) => {
          for (const spy of Object.values(spies)) spy.mockClear();
          const r = await lookup(body);
          return {
            status: r.status,
            body: JSON.stringify(r.data),
            find: spies.find.mock.calls.length,
            rate: spies.rate.mock.calls.length,
            outbox: spies.outbox.mock.calls.length,
            compare: spies.compare.mock.calls.length,
            hmac: spies.hmac.mock.calls.length,
          };
        };
        try {
          const notFound = await counted({ display_ref: "XS-ZZZZZZ", phone: CONTACT.phone });
          const wrongPhone = await counted({ display_ref: o.ref, phone: "0987654321" });
          expect(notFound).toMatchObject({ status: 202, find: 1, rate: 3, outbox: 0 });
          expect(notFound.compare).toBeGreaterThanOrEqual(1);
          expect(notFound.hmac).toBeGreaterThanOrEqual(1);
          expect(wrongPhone).toEqual(notFound);
          const ok = await counted({ display_ref: o.ref, phone: CONTACT.phone });
          expect(ok).toMatchObject({ ...notFound, outbox: 1, hmac: expect.any(Number) });
        } finally {
          for (const spy of Object.values(spies)) spy.mockRestore();
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

      it("đổi liên kết → phiên đơn; dùng lại/giả/hết hạn/sai loại → 404; hai lần đổi đồng thời chỉ một thành công", async () => {
        const o = await place([["Trắng/S", 1]], "cod");
        expect((await lookup({ display_ref: o.ref, phone: CONTACT.phone })).status).toBe(202);
        const token = String((await lookupLinks(o.orderId))[0]!.payload.token);

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
