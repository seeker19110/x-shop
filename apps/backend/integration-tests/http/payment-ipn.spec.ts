import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { isNonEmpty, vnpay } from "@x-shop/domain";
import {
  getVnpayGateway,
  MockModeVnpayGateway,
  setVnpayGatewayForTest,
} from "../../src/lib/checkout/vnpay-gateway";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { checkoutClient, DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import {
  countOrders,
  createPromotion,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

// Cửa sổ xoay khoá VNPAY (BE-INT-002, T-099): khoá hiện tại = khoá dev (đặt tường minh), khoá trước = PREVIOUS_SECRET.
// Đặt TRƯỚC khi app khởi động (medusa-config/getVnpayConfig đọc process.env); Jest cô lập process.env theo file test.
const PREVIOUS_SECRET = "xshop-test-vnpay-khoa-truoc-0123456789abcdef";
process.env.VNPAY_HASH_SECRET = DEV_VNPAY.hashSecret;
process.env.VNPAY_HASH_SECRET_PREVIOUS = PREVIOUS_SECRET;

const R = vnpay.IPN_RESPONSES;

/** Ký lại một bộ tham số vnp_* bằng khoá dev (giả lập VNPAY/kẻ tấn công biết khoá). */
function resign(params: URLSearchParams, secret: string = DEV_VNPAY.hashSecret): URLSearchParams {
  const p = Object.fromEntries([...params.entries()].filter(([k]) => k !== "vnp_SecureHash"));
  return new URLSearchParams({ ...p, vnp_SecureHash: vnpay.hmacSha512(secret, vnpay.signData(p)) });
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const client = checkoutClient(api, () => fx);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    beforeAll(() => setVnpayGatewayForTest(gateway));
    afterAll(() => setVnpayGatewayForTest(null));
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container);
    });

    async function finance(orderId: string) {
      const [fin] = await service().listOrderFinances({ order_id: orderId });
      return fin!;
    }
    const ledger = (orderId: string) => service().listPaymentLedgers({ order_id: orderId });
    const exceptions = (orderId: string | null, kind: string) =>
      service().listOpsExceptions(
        isNonEmpty(orderId) ? { order_id: orderId, kind: kind as never } : { kind: kind as never },
      );

    async function nativePaymentStatuses(orderId: string): Promise<string[]> {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["payment_collections.status"],
        filters: { id: orderId },
      });
      return ((data[0] as { payment_collections?: Array<{ status: string }> }).payment_collections ?? []).map(
        (c) => c.status,
      );
    }

    it("dùng đúng gateway giả lập đã gắn cho test (VNPAY_MODE=mock)", () => {
      expect(getVnpayGateway()).toBe(gateway);
    });

    describe("AT06 + AT35 — IPN hợp lệ xác nhận chính đơn đã có, lặp không ghi thêm", () => {
      it("IPN đầu → 00 confirmed; lặp tuần tự 19 lần → 02; order/reservation không đổi; giỏ không bị complete", async () => {
        await createPromotion(container, "IPN10", { limit: 5, percent: 10 });
        const o = await client.placeOrder(
          [
            ["Đen/M", 1],
            ["Trắng/S", 1],
          ],
          "vnpay",
          { discount_code: "IPN10" },
        );
        const ordersBefore = await countOrders(container);
        const resBefore = [
          ...(await reservationsOf(container, fx, "Đen/M")),
          ...(await reservationsOf(container, fx, "Trắng/S")),
        ].map((r) => r.id);
        const params = gateway.mock.pay(o.paymentUrl, "success");

        const first = await ipn(api, params);
        expect(first.data).toEqual(R.success);
        for (let i = 0; i < 19; i++) expect((await ipn(api, params)).data).toEqual(R.alreadyConfirmed);

        expect(await finance(o.orderId)).toMatchObject({ state: "confirmed", total: o.total });
        const rows = await ledger(o.orderId);
        expect(rows.map((r) => [r.kind, r.amount])).toEqual([["capture", o.total]]);
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        expect(pa).toMatchObject({ state: "captured", provider_txn_no: params.get("vnp_TransactionNo") });
        expect((await service().listCouponUsages({ order_id: o.orderId })).map((u) => u.state)).toEqual([
          "used",
        ]);
        const outbox = await service().listOutboxEvents({ aggregate_id: o.orderId });
        expect(outbox.filter((e) => e.type === "order.confirmed")).toHaveLength(1);
        expect(await service().listWebhookInboxes({ provider: "vnpay" })).toHaveLength(1);

        // AT35: cùng order_id, số đơn và reservation không đổi, giỏ native không bị completed_at.
        expect(await countOrders(container)).toBe(ordersBefore);
        const resAfter = [
          ...(await reservationsOf(container, fx, "Đen/M")),
          ...(await reservationsOf(container, fx, "Trắng/S")),
        ].map((r) => r.id);
        expect(resAfter.sort()).toEqual(resBefore.sort());
        const cart = await container.resolve(Modules.CART).retrieveCart(o.cartId);
        expect(cart.completed_at).toBeNull();
        // Payment collection native của ĐƠN đã thu (qua module Payment, không qua webhook native).
        expect(await nativePaymentStatuses(o.orderId)).toEqual(["completed"]);
        expect(outbox.find((e) => e.type === "payment.native_sync")?.state).toBe("sent");
      });

      it("20 IPN giống hệt gửi SONG SONG → đúng 1 bút toán, 1 lần 00, 19 lần 02", async () => {
        const o = await client.placeOrder([["Đen/S", 2]], "vnpay");
        const params = gateway.mock.pay(o.paymentUrl, "success");
        const results = await Promise.all(Array.from({ length: 20 }, () => ipn(api, params)));
        const codes = results.map((r) => r.data.RspCode).sort();
        expect(codes.filter((c) => c === "00")).toHaveLength(1);
        expect(codes.filter((c) => c === "02")).toHaveLength(19);
        expect(await ledger(o.orderId)).toHaveLength(1);
        expect((await finance(o.orderId)).state).toBe("confirmed");
        expect(await nativePaymentStatuses(o.orderId)).toEqual(["completed"]);
        expect(await countOrders(container)).toBe(1);
      });
    });

    describe("AT07 — chữ ký/số tiền/merchant sai", () => {
      it("chữ ký sai → 97 + ops_exception webhook_rejected; số tiền sai → 04; merchant khác → 97; không ghi tiền", async () => {
        const o = await client.placeOrder([["Trắng/M", 1]], "vnpay");
        const bad = gateway.mock.pay(o.paymentUrl, "success", { badSignature: true });
        expect((await ipn(api, bad)).data).toEqual(R.invalidSignature);
        expect((await ipn(api, bad)).data).toEqual(R.invalidSignature);
        const rejected = await exceptions(null, "webhook_rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.detail).toMatchObject({
          reason: "INVALID_SIGNATURE",
          txn_ref: bad.get("vnp_TxnRef"),
        });

        const noHash = new URLSearchParams(bad);
        noHash.delete("vnp_SecureHash");
        expect((await ipn(api, noHash)).data).toEqual(R.invalidSignature);

        const wrongAmount = gateway.mock.pay(o.paymentUrl, "success", { tamperAmount: o.total - 1000 });
        expect((await ipn(api, wrongAmount)).data).toEqual(R.invalidAmount);
        expect(await exceptions(o.orderId, "webhook_rejected")).toEqual([
          expect.objectContaining({
            amount: o.total - 1000,
            detail: expect.objectContaining({ reason: "amount_mismatch" }),
          }),
        ]);

        const otherMerchant = gateway.mock.pay(o.paymentUrl, "success");
        otherMerchant.set("vnp_TmnCode", "MERCHANTKHAC");
        expect((await ipn(api, resign(otherMerchant))).data).toEqual(R.invalidSignature);

        expect(await ledger(o.orderId)).toHaveLength(0);
        expect((await finance(o.orderId)).state).toBe("awaiting_payment");
      });

      it("đơn COD không nhận IPN: txnRef không thuộc payment attempt nào → 01, không đổi đơn", async () => {
        const cod = await client.placeOrder([["Đen/S", 1]], "cod");
        const vn = await client.placeOrder([["Trắng/S", 1]], "vnpay");
        const params = gateway.mock.pay(vn.paymentUrl, "success");
        params.set("vnp_TxnRef", `PA_${cod.orderId.slice(-26)}`);
        expect((await ipn(api, resign(params))).data).toEqual(R.orderNotFound);
        expect((await finance(cod.orderId)).state).toBe("placed");
        expect(await ledger(cod.orderId)).toHaveLength(0);
      });

      it("giao dịch không thành công (khách hủy) → 00, attempt failed, đơn vẫn chờ thanh toán", async () => {
        const o = await client.placeOrder([["Trắng/S", 1]], "vnpay");
        expect((await ipn(api, gateway.mock.pay(o.paymentUrl, "cancelled"))).data).toEqual(R.success);
        const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
        expect(pa!.state).toBe("failed");
        expect((await finance(o.orderId)).state).toBe("awaiting_payment");
        expect(await ledger(o.orderId)).toHaveLength(0);
      });
    });

    describe("BE-INT-002 — xoay khoá VNPAY (nhận khoá hiện tại + khoá trước)", () => {
      it("IPN ký bằng khoá TRƯỚC → 00 xác nhận; khoá lạ → 97; sửa 1 byte → 97; không ghi tiền khi bị từ chối", async () => {
        const o = await client.placeOrder([["Đen/M", 1]], "vnpay");
        const paid = gateway.mock.pay(o.paymentUrl, "success");

        const unknownKey = resign(paid, "xshop-test-vnpay-khoa-la-0123456789abcdef0123");
        expect((await ipn(api, unknownKey)).data).toEqual(R.invalidSignature);
        const tampered = resign(paid, PREVIOUS_SECRET);
        tampered.set("vnp_BankCode", "NCC");
        expect((await ipn(api, tampered)).data).toEqual(R.invalidSignature);
        expect(await ledger(o.orderId)).toHaveLength(0);

        const withPrevious = resign(paid, PREVIOUS_SECRET);
        expect(withPrevious.get("vnp_SecureHash")).not.toBe(paid.get("vnp_SecureHash"));
        expect((await ipn(api, withPrevious)).data).toEqual(R.success);
        expect(await finance(o.orderId)).toMatchObject({ state: "confirmed", total: o.total });
        // Cùng sự kiện ký bằng khoá hiện tại tới sau → cùng event key → 02, không ghi thêm.
        expect((await ipn(api, paid)).data).toEqual(R.alreadyConfirmed);
        expect((await ledger(o.orderId)).map((r) => [r.kind, r.amount])).toEqual([["capture", o.total]]);
      });

      it("URL thanh toán gửi đi ký bằng khoá HIỆN TẠI (không phải khoá trước)", async () => {
        const o = await client.placeOrder([["Trắng/M", 1]], "vnpay");
        const params = Object.fromEntries(new URL(o.paymentUrl).searchParams.entries());
        const data = vnpay.signData(params);
        expect(params.vnp_SecureHash).toBe(vnpay.hmacSha512(DEV_VNPAY.hashSecret, data));
        expect(params.vnp_SecureHash).not.toBe(vnpay.hmacSha512(PREVIOUS_SECRET, data));
      });
    });

    describe("AT08 — return/recheck không tự đổi trạng thái tiền", () => {
      it("chưa trả: status/recheck không đổi gì; return URL không có route đổi trạng thái; recheck giới hạn 10 giây", async () => {
        const o = await client.placeOrder([["Đen/M", 1]], "vnpay");
        const status = await api.get(
          `/store/x/checkout/attempts/${o.attemptId}?cart_id=${o.cartId}`,
          client.cfg(),
        );
        expect(status.data.order.state).toBe("awaiting_payment");

        // Tham số "thành công" do trình duyệt mang về (chưa có IPN) gửi tới các đường return → không có route nào xử lý.
        const fake = gateway.mock.pay(o.paymentUrl, "success");
        for (const path of ["/x/webhooks/vnpay/return", "/store/x/checkout/return", "/x/checkout/return"]) {
          const r = await api.get(`${path}?${fake.toString()}`, client.cfg());
          expect(r.status).toBe(404);
        }
        // Trên cổng giả, giao dịch vừa "trả" — đặt lại trạng thái chưa trả cho query (mô phỏng IPN/querydr chưa thấy).
        const ref = new URL(o.paymentUrl).searchParams.get("vnp_TxnRef")!;
        const unpaid = new MockModeVnpayGateway(DEV_VNPAY);
        setVnpayGatewayForTest(unpaid);
        try {
          const re = await api.post(
            `/store/x/checkout/attempts/${o.attemptId}/recheck?cart_id=${o.cartId}`,
            {},
            client.cfg(),
          );
          expect(re.status).toBe(200);
          expect(re.data).toMatchObject({ payment_check: "not_paid", order: { state: "awaiting_payment" } });
          const again = await api.post(
            `/store/x/checkout/attempts/${o.attemptId}/recheck?cart_id=${o.cartId}`,
            {},
            client.cfg(),
          );
          expect(again.status).toBe(429);
          expect(again.data.code).toBe("RATE_LIMITED");
          expect(again.headers["retry-after"]).toBe("10");
        } finally {
          setVnpayGatewayForTest(gateway);
        }
        expect(ref).toMatch(/^PA_/);
        expect(await ledger(o.orderId)).toHaveLength(0);
        expect((await finance(o.orderId)).state).toBe("awaiting_payment");
        // Người không sở hữu giỏ: 404.
        const foreign = await api.post(
          `/store/x/checkout/attempts/${o.attemptId}/recheck?cart_id=cart_khac`,
          {},
          client.cfg(),
        );
        expect(foreign.status).toBe(404);
      });

      it("đã trả nhưng IPN chưa tới: recheck → querydr paid → confirmed (inbox nguồn query); IPN tới sau → 02", async () => {
        const o = await client.placeOrder([["Trắng/M", 2]], "vnpay");
        const params = gateway.mock.pay(o.paymentUrl, "success");
        const re = await api.post(
          `/store/x/checkout/attempts/${o.attemptId}/recheck?cart_id=${o.cartId}`,
          {},
          client.cfg(),
        );
        expect(re.data).toMatchObject({ payment_check: "paid", order: { state: "confirmed" } });
        const inbox = await service().listWebhookInboxes({ provider: "vnpay" });
        expect(inbox.map((i) => i.source)).toEqual(["query"]);
        expect((await ipn(api, params)).data).toEqual(R.alreadyConfirmed);
        expect(await ledger(o.orderId)).toHaveLength(1);
      });
    });

    describe("AT36 — hai giao dịch thật cùng thành công", () => {
      it("2 capture, xác nhận một lần, ngoại lệ overpayment đúng số dư", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
        const first = gateway.mock.pay(o.paymentUrl, "success");
        const second = gateway.mock.pay(o.paymentUrl, "success");
        expect(first.get("vnp_TransactionNo")).not.toBe(second.get("vnp_TransactionNo"));
        expect((await ipn(api, first)).data).toEqual(R.success);
        expect((await ipn(api, second)).data).toEqual(R.success);
        expect((await ipn(api, second)).data).toEqual(R.alreadyConfirmed);

        const rows = await ledger(o.orderId);
        expect(rows.map((r) => r.amount)).toEqual([o.total, o.total]);
        expect((await finance(o.orderId)).state).toBe("confirmed");
        const outbox = await service().listOutboxEvents({ aggregate_id: o.orderId });
        expect(outbox.filter((e) => e.type === "order.confirmed")).toHaveLength(1);
        const over = await exceptions(o.orderId, "overpayment");
        expect(over.map((e) => e.amount)).toEqual([o.total]);
        expect(await nativePaymentStatuses(o.orderId)).toEqual(["completed"]);
      });
    });

    describe("AT09 — tiền đến sau khi đơn đã hủy", () => {
      it("ghi capture + ngoại lệ late_payment; đơn vẫn cancelled, không xác nhận", async () => {
        const o = await client.placeOrder([["Trắng/S", 1]], "vnpay");
        // Hủy (job hết hạn ở T-012 làm việc này — test checkout-expiry kiểm cả đường đó).
        await service().updateOrderFinances({ id: (await finance(o.orderId)).id, state: "cancelled" });
        const params = gateway.mock.pay(o.paymentUrl, "success");
        expect((await ipn(api, params)).data).toEqual(R.success);
        expect((await finance(o.orderId)).state).toBe("cancelled");
        expect((await ledger(o.orderId)).map((r) => r.amount)).toEqual([o.total]);
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.amount)).toEqual([o.total]);
        const outbox = await service().listOutboxEvents({ aggregate_id: o.orderId });
        expect(outbox.filter((e) => e.type === "order.confirmed")).toHaveLength(0);
        expect(await nativePaymentStatuses(o.orderId)).toEqual([]);
      });
    });

    describe("T-168 — attempt `failed` mang mã của thông báo thất bại, tiền về với mã khác (đơn CHƯA hủy)", () => {
      it("đơn vẫn xác nhận như thường; attempt giữ `failed` + mã cũ (không ghi đè); mở payment_unknown attempt_txn_conflict", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
        const failed = gateway.mock.pay(o.paymentUrl, "failed");
        const tFail = failed.get("vnp_TransactionNo")!;
        expect((await ipn(api, failed)).data).toEqual(R.success);
        const [pa0] = await service().listPaymentAttempts({ order_id: o.orderId });
        expect(pa0).toMatchObject({ state: "failed", provider_txn_no: tFail });
        expect((await finance(o.orderId)).state).toBe("awaiting_payment");

        const paid = gateway.mock.pay(o.paymentUrl, "success");
        const tPaid = paid.get("vnp_TransactionNo")!;
        expect((await ipn(api, paid)).data).toEqual(R.success);
        expect((await finance(o.orderId)).state).toBe("confirmed");
        expect((await ledger(o.orderId)).map((r) => [r.amount, r.provider_txn_id])).toEqual([
          [o.total, tPaid],
        ]);
        const [pa1] = await service().listPaymentAttempts({ order_id: o.orderId });
        expect(pa1).toMatchObject({ state: "failed", provider_txn_no: tFail });
        const conflict = await exceptions(o.orderId, "payment_unknown");
        expect(conflict.map((e) => [e.priority, e.amount, e.state])).toEqual([["high", o.total, "open"]]);
        expect(conflict[0]!.detail).toMatchObject({
          reason: "attempt_txn_conflict",
          provider_txn_id: tPaid,
          attempt_provider_txn_no: tFail,
          attempt_state: "failed",
          order_state: "awaiting_payment",
        });
        expect(await exceptions(o.orderId, "late_payment")).toHaveLength(0);
        // Gửi lại → 02, không mở thêm ngoại lệ, không đổi attempt.
        expect((await ipn(api, paid)).data).toEqual(R.alreadyConfirmed);
        expect(await exceptions(o.orderId, "payment_unknown")).toHaveLength(1);
        expect((await service().listPaymentAttempts({ order_id: o.orderId }))[0]).toMatchObject({
          provider_txn_no: tFail,
        });
      });
    });
  },
});
