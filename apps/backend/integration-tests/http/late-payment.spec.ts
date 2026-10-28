import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import { expireHolds } from "../../src/lib/checkout/jobs";
import {
  setVnpayGatewayForTest,
  type QueryStatusResult,
  type VnpayGateway,
} from "../../src/lib/checkout/vnpay-gateway";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import {
  DisabledRefundGateway,
  MockVnpayRefundGateway,
  setRefundGatewayForTest,
} from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, loginWithMfa, totp, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { checkoutClient, DEV_VNPAY, ipn, type Api, type Res } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

const R = vnpay.IPN_RESPONSES;
const MIN = 60_000;
const HEADER = "reference,amount,occurred_at,type";

type Role = "owner" | "accountant" | "warehouse";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- thân JSON của API test không có kiểu; kiểm bằng expect từng trường
type J = Record<string, any>;

/** querydr lập trình được theo txnRef (mặc định "chưa trả" → job hết hạn hủy đơn). */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    return (
      this.results.get(input.txnRef) ?? { outcome: "not_paid", transactionNo: null, reason: "status_01" }
    );
  }
}

const key = () => `lp-${randomUUID()}`;

/**
 * T-168 (D-122) — khoản thu VNPAY đến SAU khi đơn đã hủy (AT09). Đơn bị hủy (hết hạn / owner hủy chưa xác minh) để
 * attempt `failed` KHÔNG có mã giao dịch; IPN thành công đến sau phải: gắn `provider_txn_no` vào attempt (GIỮ `failed`,
 * đơn vẫn `cancelled`, vẫn mở `late_payment`) → hoàn qua cổng (mock) tìm được giao dịch gốc → `late_payment` đóng khi tiền
 * đã trả lại hết; đối soát VNPAY gắn được dòng sao kê vào khoản thu/đơn đó (không thành "thừa"/"thiếu"). IPN gửi lại không
 * đổi gì; hai mã giao dịch khác nhau cho cùng attempt → không ghi đè, mở ngoại lệ.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let gateway: ScriptedGateway;
    let refundGw: MockVnpayRefundGateway;
    const staff = {} as Record<Role, MfaAdmin>;
    const client = checkoutClient(api, () => fx);
    const signer = new vnpay.MockVnpayGateway(DEV_VNPAY);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const A = (role: Role) => staff[role].headers;
    const future = (ms: number) => new Date(Date.now() + ms);

    const post = (path: string, headers: Record<string, string>, body: unknown, extra = {}) =>
      api.post(path, body, { headers: { ...headers, ...extra }, validateStatus: () => true }) as Promise<
        Res<J>
      >;
    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const attemptOf = async (orderId: string) =>
      (await service().listPaymentAttempts({ order_id: orderId }))[0]!;
    const exceptions = (orderId: string, kind: "late_payment" | "payment_unknown") =>
      service().listOpsExceptions({ order_id: orderId, kind });
    /** Hàng `x_refund` (giao dịch gốc `capture_ref`, mã yêu cầu cổng — không có trong phản hồi API). */
    const refundRow = async (id: string) =>
      (await container
        .resolve(ContainerRegistrationKeys.PG_CONNECTION)("x_refund")
        .where({ id })
        .first()) as { capture_ref: string | null; provider_request_id: string; method: string };
    const ledgerOf = async (orderId: string) =>
      (await service().listPaymentLedgers({ order_id: orderId }, { order: { created_at: "ASC" } })).map(
        (l) => ({ id: l.id, kind: l.kind, amount: Number(l.amount), provider_txn_id: l.provider_txn_id }),
      );

    /** Đơn VNPAY bị job hết hạn hủy (querydr "chưa trả") → attempt `failed`, chưa có mã giao dịch. */
    async function expiredOrder(variant: string) {
      const o = await client.placeOrder([[variant, 1]], "vnpay");
      expect((await expireHolds(container, { now: future(16 * MIN) })).cancelled).toContain(o.orderId);
      const pa = await attemptOf(o.orderId);
      expect(pa).toMatchObject({ state: "failed", provider_txn_no: null });
      expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
      return { ...o, txnRef: pa.txn_ref };
    }

    /** Tạo yêu cầu hoàn (kế toán) → duyệt nếu cần (owner) → thực hiện (kế toán). */
    async function refund(
      orderId: string,
      amount: number,
      method: "provider" | "manual" | "auto",
      evidence?: string,
    ) {
      const created = await post(
        "/admin/x/refunds",
        A("accountant"),
        { order_id: orderId, reason: "late_payment", amount, method, note: "Tiền đến sau khi hủy" },
        { "Idempotency-Key": key() },
      );
      expect(created.status).toBe(201);
      const id = String(created.data.refund.id);
      if (created.data.refund.state === "requested") {
        expect((await post(`/admin/x/refunds/${id}/approve`, A("owner"), {})).status).toBe(200);
      }
      const exec = await post(
        `/admin/x/refunds/${id}/execute`,
        A("accountant"),
        evidence ? { evidence_ref: evidence } : {},
      );
      return { created: created.data.refund as J, exec };
    }

    const importVnpay = (csv: string, params: Record<string, string> = {}) =>
      api.post(
        `/admin/x/settlements/batches?${new URLSearchParams({ source: "vnpay", ...params }).toString()}`,
        csv,
        {
          headers: { ...A("accountant"), "content-type": "text/csv" },
          validateStatus: () => true,
        },
      ) as Promise<Res<J>>;
    const csvOf = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";
    const csvLine = (ref: string, amount: number, type: "payment" | "refund", at = new Date()) =>
      `${ref},${amount},${at.toISOString()},${type}`;

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["owner", "accountant", "warehouse"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setRefundGatewayForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 50, "Đen/M": 50, "Trắng/S": 50, "Trắng/M": 50 },
      });
      gateway = new ScriptedGateway();
      setVnpayGatewayForTest(gateway);
      refundGw = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(refundGw);
      // cancel-unverified đòi xác thực lại ≤ 5 phút (D-122): owner đăng nhập lại mỗi ca.
      staff.owner = {
        ...staff.owner,
        headers: await loginWithMfa(rawApi as unknown as HttpClient, staff.owner, {
          method: "totp",
          code: totp(staff.owner.secret),
        }),
      };
    });

    describe("đơn hết hạn bị hủy → IPN thành công → hoàn qua cổng", () => {
      it("attempt giữ `failed` nhưng mang mã giao dịch; hoàn toàn phần qua cổng (mock) thành công; late_payment đóng; đơn vẫn cancelled", async () => {
        const o = await expiredOrder("Trắng/S");
        const paid = signer.pay(o.paymentUrl, "success");
        const txnNo = paid.get("vnp_TransactionNo")!;
        expect((await ipn(api, paid)).data).toEqual(R.success);

        expect(await attemptOf(o.orderId)).toMatchObject({ state: "failed", provider_txn_no: txnNo });
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => [e.amount, e.state])).toEqual([
          [o.total, "open"],
        ]);
        expect(await exceptions(o.orderId, "payment_unknown")).toHaveLength(0);

        refundGw.captured.set(o.txnRef, o.total);
        const { created, exec } = await refund(o.orderId, o.total, "provider");
        expect(created).toMatchObject({ method: "provider", provider: "vnpay" });
        expect((await refundRow(created.id)).capture_ref).toBe(txnNo);
        expect({ status: exec.status, outcome: exec.data.outcome, code: exec.data.code }).toEqual({
          status: 200,
          outcome: "succeeded",
          code: undefined,
        });
        // Cổng nhận đúng giao dịch gốc: txnRef + mã giao dịch VNPAY, hoàn toàn phần (02).
        expect(refundGw.bodies).toHaveLength(1);
        expect(refundGw.bodies[0]).toMatchObject({
          vnp_TxnRef: o.txnRef,
          vnp_TransactionNo: txnNo,
          vnp_TransactionType: "02",
          vnp_Amount: String(o.total * 100),
        });
        expect(refundGw.totalRefunded(o.txnRef)).toBe(o.total);

        expect((await ledgerOf(o.orderId)).map((l) => [l.kind, l.amount])).toEqual([
          ["capture", o.total],
          ["refund", o.total],
        ]);
        const late = await exceptions(o.orderId, "late_payment");
        expect(late.map((e) => e.state)).toEqual(["resolved"]);
        expect(late[0]!.detail).toMatchObject({ resolution: "refunded", refund_id: created.id });
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect((await attemptOf(o.orderId)).state).toBe("failed");
      });

      it("hoàn từng phần: phần đầu (03) → late_payment còn mở; hoàn nốt → đóng; hoàn thêm → vượt số thu (422/409)", async () => {
        const o = await expiredOrder("Trắng/M");
        const paid = signer.pay(o.paymentUrl, "success");
        expect((await ipn(api, paid)).data).toEqual(R.success);
        refundGw.captured.set(o.txnRef, o.total);
        const half = Math.floor(o.total / 2);

        const first = await refund(o.orderId, half, "auto");
        expect(first.created).toMatchObject({ method: "provider" });
        expect(first.exec.data.outcome).toBe("succeeded");
        expect(refundGw.bodies[0]).toMatchObject({ vnp_TransactionType: "03" });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open"]);

        const rest = await refund(o.orderId, o.total - half, "provider");
        expect(rest.exec.data.outcome).toBe("succeeded");
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["resolved"]);
        expect(refundGw.totalRefunded(o.txnRef)).toBe(o.total);

        const over = await post(
          "/admin/x/refunds",
          A("accountant"),
          { order_id: o.orderId, reason: "late_payment", amount: 1, method: "provider", note: "thử vượt" },
          { "Idempotency-Key": key() },
        );
        expect(over.data.code).toBe("REFUND_EXCEEDS_CAPTURED");
      });

      it("sandbox/live (cổng hoàn TẮT) → 409 REFUND_PROVIDER_DISABLED, không đổi trạng thái; hoàn tay có chứng từ vẫn đóng được late_payment", async () => {
        const o = await expiredOrder("Đen/S");
        expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).data).toEqual(R.success);
        setRefundGatewayForTest(new DisabledRefundGateway());
        const { created, exec } = await refund(o.orderId, o.total, "provider");
        expect({ status: exec.status, code: exec.data.code }).toEqual({
          status: 409,
          code: "REFUND_PROVIDER_DISABLED",
        });
        expect(await ledgerOf(o.orderId)).toHaveLength(1);
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open"]);
        // Hủy yêu cầu cổng không được (chỉ `failed` hủy được) → yêu cầu vẫn giữ số tiền; đơn dùng hoàn tay ở đơn khác.
        expect(created.state).toMatch(/approved|requested/);

        const o2 = await expiredOrder("Đen/M");
        expect((await ipn(api, signer.pay(o2.paymentUrl, "success"))).data).toEqual(R.success);
        const manual = await refund(o2.orderId, o2.total, "manual", "CK-20261028-001");
        expect(manual.exec.data.outcome).toBe("succeeded");
        expect((await exceptions(o2.orderId, "late_payment")).map((e) => e.state)).toEqual(["resolved"]);
      });
    });

    describe("owner hủy chưa xác minh → IPN thành công → hoàn qua cổng", () => {
      it("cancel-unverified → IPN → attempt `failed` mang mã; kho không tạo được hoàn (403); kế toán hoàn qua cổng → late_payment đóng", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
        const pa0 = await attemptOf(o.orderId);
        gateway.results.set(pa0.txn_ref, { outcome: "unknown", transactionNo: null, reason: "status_91" });
        expect((await expireHolds(container, { now: future(16 * MIN) })).unknown).toContain(o.orderId);
        const cancelled = await post(
          `/admin/x/orders/${o.orderId}/cancel-unverified`,
          A("owner"),
          {
            reason: "Đã đối chiếu cổng merchant VNPAY: không có giao dịch thành công cho txn_ref",
            merchant_ref: "VNP-14422574",
          },
          { "Idempotency-Key": key() },
        );
        expect(cancelled).toMatchObject({ status: 200, data: { state: "cancelled" } });
        expect(await attemptOf(o.orderId)).toMatchObject({ state: "failed", provider_txn_no: null });

        const paid = signer.pay(o.paymentUrl, "success");
        const txnNo = paid.get("vnp_TransactionNo")!;
        expect((await ipn(api, paid)).data).toEqual(R.success);
        expect(await attemptOf(o.orderId)).toMatchObject({ state: "failed", provider_txn_no: txnNo });
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open"]);

        // Phân quyền: kho không có refund.create → 403, không ghi yêu cầu.
        const denied = await post(
          "/admin/x/refunds",
          A("warehouse"),
          { order_id: o.orderId, reason: "late_payment", amount: o.total, method: "provider", note: "x" },
          { "Idempotency-Key": key() },
        );
        expect(denied.status).toBe(403);

        refundGw.captured.set(pa0.txn_ref, o.total);
        const { created, exec } = await refund(o.orderId, o.total, "provider");
        expect(created).toMatchObject({ method: "provider" });
        expect((await refundRow(created.id)).capture_ref).toBe(txnNo);
        expect(exec.data.outcome).toBe("succeeded");
        expect(refundGw.bodies[0]).toMatchObject({ vnp_TxnRef: pa0.txn_ref, vnp_TransactionNo: txnNo });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["resolved"]);
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
      });
    });

    describe("đối soát VNPAY", () => {
      it("dòng sao kê của khoản thu đến muộn gắn vào khoản thu/đơn (late_after_cancel, không 'thừa'); dòng hoàn khớp; khoản thu muộn vắng mặt trên sao kê → 'thiếu' (có trong tập phải đối soát)", async () => {
        const o = await expiredOrder("Trắng/S");
        expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).data).toEqual(R.success);
        refundGw.captured.set(o.txnRef, o.total);
        const { created, exec } = await refund(o.orderId, o.total, "provider");
        expect(exec.data.outcome).toBe("succeeded");
        const capture = (await ledgerOf(o.orderId)).find((l) => l.kind === "capture")!;
        const providerRequestId = (await refundRow(created.id)).provider_request_id;

        const r1 = await importVnpay(
          csvOf(csvLine(o.txnRef, o.total, "payment"), csvLine(providerRequestId, o.total, "refund")),
        );
        expect(r1.status).toBe(201);
        const lines = r1.data.lines as J[];
        expect(lines.find((l) => l.type === "payment")).toMatchObject({
          order_id: o.orderId,
          result: "late_after_cancel",
          target_kind: "capture",
          target_id: capture.id,
        });
        expect(lines.find((l) => l.type === "refund")).toMatchObject({
          result: "matched",
          target_kind: "refund",
          target_id: created.id,
        });
        const mine = (r1.data.discrepancies as J[]).filter((d) => d.order_id === o.orderId);
        expect(mine.map((d) => d.kind)).toEqual(["late_after_cancel"]);
        expect(mine[0]).toMatchObject({ target_id: capture.id, amount: o.total, priority: "high" });

        // Khoản thu muộn KHÔNG có trên sao kê (kỳ đã qua thời điểm thu) → "thiếu" gắn đúng khoản thu, tham chiếu txn_ref.
        const o2 = await expiredOrder("Trắng/M");
        expect((await ipn(api, signer.pay(o2.paymentUrl, "success"))).data).toEqual(R.success);
        const capture2 = (await ledgerOf(o2.orderId)).find((l) => l.kind === "capture")!;
        const r2 = await importVnpay(csvOf(csvLine("KHONG-CO-GIAO-DICH", 1_000, "payment")), {
          period_end: future(MIN).toISOString(),
        });
        expect(r2.status).toBe(201);
        const missing = (r2.data.discrepancies as J[]).filter((d) => d.kind === "missing");
        expect(missing.filter((d) => d.order_id === o2.orderId)).toEqual([
          expect.objectContaining({
            target_id: capture2.id,
            reference: o2.txnRef,
            expected_amount: o2.total,
          }),
        ]);
        // Khoản thu đã có trên sao kê trước (o) không bị báo thiếu lần nữa.
        expect(missing.filter((d) => d.order_id === o.orderId)).toEqual([]);
      });
    });

    describe("idempotent + đồng thời", () => {
      it("IPN gửi lại (tuần tự và song song) → 02, không đổi attempt/ledger/ngoại lệ; sau khi đã hoàn, gửi lại không mở lại late_payment", async () => {
        const o = await expiredOrder("Đen/M");
        const paid = signer.pay(o.paymentUrl, "success");
        const txnNo = paid.get("vnp_TransactionNo")!;
        const first = await Promise.all(Array.from({ length: 5 }, () => ipn(api, paid)));
        const codes = first.map((r) => r.data.RspCode);
        expect(codes.filter((c) => c === R.success.RspCode)).toHaveLength(1);
        expect(codes.every((c) => [R.success.RspCode, R.alreadyConfirmed.RspCode, "99"].includes(c))).toBe(
          true,
        );
        const pa1 = await attemptOf(o.orderId);
        expect(pa1).toMatchObject({ state: "failed", provider_txn_no: txnNo });
        const snapshot = async () => ({
          attempt: await attemptOf(o.orderId),
          ledger: await ledgerOf(o.orderId),
          late: (await exceptions(o.orderId, "late_payment")).map((e) => [e.id, e.state, e.amount]),
          unknown: await exceptions(o.orderId, "payment_unknown"),
        });
        const before = await snapshot();
        expect(before.ledger).toHaveLength(1);
        expect(before.late).toHaveLength(1);
        for (let i = 0; i < 3; i++) expect((await ipn(api, paid)).data).toEqual(R.alreadyConfirmed);
        expect(await snapshot()).toEqual(before);

        refundGw.captured.set(o.txnRef, o.total);
        expect((await refund(o.orderId, o.total, "provider")).exec.data.outcome).toBe("succeeded");
        const afterRefund = await snapshot();
        expect((await ipn(api, paid)).data).toEqual(R.alreadyConfirmed);
        expect(await snapshot()).toEqual(afterRefund);
        expect(afterRefund.late.map((l) => l[1])).toEqual(["resolved"]);
      });

      it("hai IPN thành công KHÁC mã giao dịch cho cùng attempt đã hủy (song song) → mã đầu được gắn, mã sau không ghi đè + ngoại lệ attempt_txn_conflict; cả hai khoản thu ghi ledger", async () => {
        const o = await expiredOrder("Trắng/S");
        const p1 = signer.pay(o.paymentUrl, "success");
        const p2 = signer.pay(o.paymentUrl, "success");
        const t1 = p1.get("vnp_TransactionNo")!;
        const t2 = p2.get("vnp_TransactionNo")!;
        expect(t1).not.toBe(t2);
        const res = await Promise.all([ipn(api, p1), ipn(api, p2)]);
        // Bận khóa → 99 (VNPAY gửi lại) — gửi lại cho đến khi cả hai đã ghi.
        for (const [i, r] of res.entries()) {
          if (r.data.RspCode === "99") expect((await ipn(api, i === 0 ? p1 : p2)).data).toEqual(R.success);
          else expect(r.data).toEqual(R.success);
        }
        const pa = await attemptOf(o.orderId);
        expect(pa.state).toBe("failed");
        expect([t1, t2]).toContain(pa.provider_txn_no);
        const other = pa.provider_txn_no === t1 ? t2 : t1;
        const ledger = await ledgerOf(o.orderId);
        expect(ledger.map((l) => l.provider_txn_id).sort()).toEqual([t1, t2].sort());
        expect(await exceptions(o.orderId, "late_payment")).toHaveLength(2);
        const conflict = await exceptions(o.orderId, "payment_unknown");
        expect(conflict).toHaveLength(1);
        expect(conflict[0]).toMatchObject({ priority: "high", amount: o.total, state: "open" });
        expect(conflict[0]!.detail).toMatchObject({
          reason: "attempt_txn_conflict",
          txn_ref: o.txnRef,
          provider_txn_id: other,
          attempt_provider_txn_no: pa.provider_txn_no,
          attempt_state: "failed",
        });
        // Gửi lại mã sau → không đổi gì (không mở thêm ngoại lệ, không ghi đè).
        expect((await ipn(api, other === t1 ? p1 : p2)).data).toEqual(R.alreadyConfirmed);
        expect((await attemptOf(o.orderId)).provider_txn_no).toBe(pa.provider_txn_no);
        expect(await exceptions(o.orderId, "payment_unknown")).toHaveLength(1);

        // Khoản thu gắn với attempt hoàn qua cổng được; khoản kia hoàn tay có chứng từ → ròng 0 → mọi late_payment đóng.
        refundGw.captured.set(o.txnRef, o.total);
        const viaGateway = await refund(o.orderId, o.total, "provider");
        expect((await refundRow(viaGateway.created.id)).capture_ref).toBe(pa.provider_txn_no);
        expect(viaGateway.exec.data.outcome).toBe("succeeded");
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open", "open"]);
        const manual = await refund(o.orderId, o.total, "manual", "CK-20261028-002");
        expect(manual.exec.data.outcome).toBe("succeeded");
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual([
          "resolved",
          "resolved",
        ]);
      });

      it("attempt đã `failed` kèm mã của thông báo THẤT BẠI, sau đó tiền về với mã khác → không ghi đè mã cũ, mở ngoại lệ; late_payment vẫn mở", async () => {
        const o = await client.placeOrder([["Đen/S", 1]], "vnpay");
        const failed = signer.pay(o.paymentUrl, "failed");
        const tFail = failed.get("vnp_TransactionNo")!;
        expect((await ipn(api, failed)).data).toEqual(R.success);
        expect(await attemptOf(o.orderId)).toMatchObject({ state: "failed", provider_txn_no: tFail });
        expect((await expireHolds(container, { now: future(16 * MIN) })).cancelled).toContain(o.orderId);

        const paid = signer.pay(o.paymentUrl, "success");
        const tPaid = paid.get("vnp_TransactionNo")!;
        expect((await ipn(api, paid)).data).toEqual(R.success);
        expect(await attemptOf(o.orderId)).toMatchObject({ state: "failed", provider_txn_no: tFail });
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open"]);
        const conflict = await exceptions(o.orderId, "payment_unknown");
        expect(conflict.map((e) => e.detail)).toEqual([
          expect.objectContaining({
            reason: "attempt_txn_conflict",
            provider_txn_id: tPaid,
            attempt_provider_txn_no: tFail,
          }),
        ]);
      });
    });
  },
});
