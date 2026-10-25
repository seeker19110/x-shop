import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_CONFIG } from "../../src/modules/returns/constants";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import {
  DisabledRefundGateway,
  MockVnpayRefundGateway,
  setRefundGatewayForTest,
} from "../../src/workflows/returns/refund-gateway";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { reservationsOf, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-027 — hoàn tiền (S-108, S-403, AT16, AT21, POST02/D-012): Σ hoàn ≤ Σ đã thu (cả yêu cầu đang giữ), tiền nguyên VND,
 * idempotency theo khóa, hai yêu cầu song song không vượt, retry/timeout dùng CÙNG mã ở cổng (không hoàn trùng), duyệt
 * hai người khi vượt ngưỡng, hủy đơn đã thu → hoàn không chờ hàng trả + hủy đơn native khi tiền đã hoàn.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let refundGateway: MockVnpayRefundGateway;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"order_staff" | "support" | "warehouse" | "accountant", MfaAdmin>;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);
    const A = (role: keyof typeof staff) => staff[role].headers;
    const createRefund = (headers: Record<string, string>, body: object, k: string = key()) =>
      flow.admin("/admin/x/refunds", headers, body, { "Idempotency-Key": k });
    const other = (o: PlacedOrder, amount: unknown, extra: object = {}) => ({
      order_id: o.orderId,
      reason: "other",
      amount,
      note: "Hoàn bù chênh lệch",
      ...extra,
    });

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "accountant"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
      setRefundGatewayForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 20, "Đen/M": 20, "Trắng/S": 20, "Trắng/M": 20 },
      });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      clearShippingFeeCache();
      refundGateway = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(refundGateway);
      ip = newIp();
    });

    describe("hủy đơn đã thu tiền (POST02, D-012) — hoàn không chờ hàng trả, hủy native khi tiền đã hoàn", () => {
      it("khách hủy → yêu cầu hoàn toàn bộ; duyệt + thực hiện → cổng hoàn đủ một lần, đơn native hủy, ngoại lệ đóng", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        expect(o.total).toBe(730_000);
        const cancelled = await flow.cancel(o);
        expect(cancelled.status).toBe(200);
        expect(cancelled.data.cancel).toEqual({ outcome: "cancelled", refund_requested: true });
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).not.toBe("canceled");

        const summary = await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("accountant"));
        expect(summary.data).toMatchObject({ captured: 730_000, refunded: 0, held: 730_000, refundable: 0 });
        const refund = summary.data.refunds[0];
        expect(refund).toMatchObject({
          reason: "cancellation",
          amount: 730_000,
          method: "provider",
          state: "requested",
          requested_by: "customer",
        });
        // Khách hủy lại → idempotent, không mở yêu cầu thứ hai.
        expect((await flow.cancel(o)).data.cancel.outcome).toBe("already_cancelled");
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(1);

        // Chưa duyệt → không thực hiện được.
        const early = await flow.admin(`/admin/x/refunds/${refund.id}/execute`, A("accountant"));
        expect(early).toMatchObject({ status: 409, data: { code: "REFUND_NOT_APPROVED" } });
        expect((await flow.admin(`/admin/x/refunds/${refund.id}/approve`, A("accountant"))).status).toBe(200);
        const exec = await flow.admin(`/admin/x/refunds/${refund.id}/execute`, A("accountant"));
        expect(exec.data).toMatchObject({ outcome: "succeeded", refund: { state: "succeeded" } });
        expect(refundGateway.totalRefunded()).toBe(730_000);
        expect(refundGateway.bodies[0]).toMatchObject({ vnp_TransactionType: "02", vnp_Amount: "73000000" });

        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).toBe("canceled");
        const exceptions = await checkout().listOpsExceptions({
          order_id: o.orderId,
          kind: "refund_request",
        });
        expect(exceptions.map((e) => e.state)).toEqual(["resolved"]);
        const ledger = await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" });
        expect(ledger.map((l) => [Number(l.amount), l.state])).toEqual([[730_000, "succeeded"]]);

        // Gọi lại → đã xong, cổng không bị gọi thêm.
        const calls = refundGateway.calls;
        const again = await flow.admin(`/admin/x/refunds/${refund.id}/execute`, A("accountant"));
        expect(again.data.outcome).toBe("already_succeeded");
        expect(refundGateway.calls).toBe(calls);
        const view = await api.get(`/store/x/orders/${o.ref}`, {
          headers: {
            "x-publishable-api-key": fx.publishableKey,
            "x-order-access": o.access,
            "x-forwarded-for": ip,
          },
        });
        expect((view.data as unknown as { totals: { paid: number } }).totals.paid).toBe(0);
      });

      it("đơn đã tạo vận đơn → khách không hủy được (409 NOT_CANCELLABLE) — đi luồng đổi trả", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const created = await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("order_staff"));
        expect(created.status).toBe(201);
        const r = await flow.cancel(o);
        expect(r).toMatchObject({ status: 409, data: { code: "NOT_CANCELLABLE" } });
        expect((await checkout().listOrderFinances({ order_id: o.orderId }))[0]!.state).toBe("confirmed");
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
      });
    });

    describe("bất biến tiền: hoàn ≤ đã thu, số nguyên VND, idempotency, đồng thời", () => {
      it("vượt số đã thu → 422; tiền không nguyên/âm/chuỗi → 422; đơn chưa thu (COD chưa giao) → 422", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const over = await createRefund(A("accountant"), other(o, 730_001));
        expect(over).toMatchObject({
          status: 422,
          data: { code: "REFUND_EXCEEDS_CAPTURED", refundable: 730_000 },
        });
        for (const amount of [100.5, -1, 0, "100000", Number.MAX_SAFE_INTEGER + 2]) {
          const r = await createRefund(A("accountant"), other(o, amount));
          expect({ amount, status: r.status }).toEqual({ amount, status: 422 });
        }
        const cod = await flow.place([["Đen/S", 1]], "cod");
        const none = await createRefund(A("accountant"), other(cod, 1_000));
        expect(none).toMatchObject({ status: 422, data: { code: "REFUND_EXCEEDS_CAPTURED", refundable: 0 } });
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
      });

      it("10 yêu cầu 100.000 song song trên 730.000 đã thu → đúng 7 được ghi; tổng giữ không vượt", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const results = await Promise.all(
          Array.from({ length: 10 }, () => createRefund(A("accountant"), other(o, 100_000))),
        );
        expect(results.filter((r) => r.status === 201)).toHaveLength(7);
        expect(results.filter((r) => r.status === 422).map((r) => r.data.code)).toEqual(
          Array(3).fill("REFUND_EXCEEDS_CAPTURED"),
        );
        const rows = await returns().listRefundsOfOrder(o.orderId);
        expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(700_000);
        // Hai yêu cầu song song tranh 30.000 cuối → đúng một.
        const last = await Promise.all([
          createRefund(A("accountant"), other(o, 30_000)),
          createRefund(A("accountant"), other(o, 30_000)),
        ]);
        expect(last.map((r) => r.status).sort()).toEqual([201, 422]);
        const summary = await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("accountant"));
        expect(summary.data).toMatchObject({ captured: 730_000, held: 730_000, refundable: 0 });
      });

      it("cùng Idempotency-Key ×5 song song → một bản ghi (201 + 200×4); khác nội dung → 409", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const k = key();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => createRefund(A("accountant"), other(o, 50_000), k)),
        );
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
        expect(new Set(results.map((r) => r.data.refund.id)).size).toBe(1);
        expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(4);
        const conflict = await createRefund(A("accountant"), other(o, 60_000), k);
        expect(conflict).toMatchObject({ status: 409, data: { code: "IDEMPOTENCY_CONFLICT" } });
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(1);
      });
    });

    describe("duyệt hai người (S-403) + quyền (AT21)", () => {
      it("vượt ngưỡng: người tạo không tự duyệt (403 SELF_APPROVAL), người thứ hai duyệt được; dưới ngưỡng kế toán tự duyệt", async () => {
        // MFA mới (xác thực lại ≤ 5 phút cho thao tác vượt ngưỡng — S-402).
        const acc1 = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const acc2 = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const o = await flow.place([["Đen/M", 2]], "vnpay");
        expect(o.total).toBe(1_430_000);
        const big = RETURNS_CONFIG.refundApprovalThresholdVnd + 200_000;
        const created = await createRefund(acc1.headers, other(o, big));
        expect(created.status).toBe(201);
        expect(created.data.refund).toMatchObject({
          state: "requested",
          approval_required: true,
          amount: big,
        });
        const id = created.data.refund.id as string;

        const self = await flow.admin(`/admin/x/refunds/${id}/approve`, acc1.headers);
        expect(self).toMatchObject({ status: 403, data: { code: "SELF_APPROVAL" } });
        // CSKH (chỉ refund.request) không duyệt/thực hiện được; kho không làm gì được với hoàn tiền.
        expect((await flow.admin(`/admin/x/refunds/${id}/approve`, A("support"))).status).toBe(403);
        expect((await flow.admin(`/admin/x/refunds/${id}/execute`, A("support"))).status).toBe(403);
        expect((await createRefund(A("warehouse"), other(o, 10_000))).status).toBe(403);
        expect((await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("warehouse"))).status).toBe(
          403,
        );

        const ok = await flow.admin(`/admin/x/refunds/${id}/approve`, acc2.headers);
        expect(ok.data).toMatchObject({
          changed: true,
          refund: { state: "approved", approved_by: acc2.userId },
        });
        expect((await flow.admin(`/admin/x/refunds/${id}/execute`, acc1.headers)).data.outcome).toBe(
          "succeeded",
        );

        // Dưới ngưỡng: người tạo có refund.approve → duyệt luôn. CSKH tạo → chờ người có quyền duyệt.
        const small = await createRefund(acc1.headers, other(o, 100_000));
        expect(small.data.refund).toMatchObject({ state: "approved", approved_by: acc1.userId });
        const bySupport = await createRefund(A("support"), other(o, 50_000));
        expect(bySupport.data.refund).toMatchObject({ state: "requested", approval_required: false });
        const rejected = await flow.admin(
          `/admin/x/refunds/${bySupport.data.refund.id}/reject`,
          acc2.headers,
          {
            reason: "Không đủ chứng từ",
          },
        );
        expect(rejected.data.refund.state).toBe("rejected");
        const summary = await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, acc1.headers);
        // Bị từ chối → nhả số đang giữ.
        expect(summary.data).toMatchObject({
          refunded: big,
          held: 100_000,
          refundable: 1_430_000 - big - 100_000,
        });

        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { resource_type: "refund", resource_id: id },
          { limit: 10, offset: 0 },
        );
        expect(entries.map((e) => e.action).sort()).toEqual([
          "refund.approved",
          "refund.requested",
          "refund.succeeded",
        ]);
        expect(entries.find((e) => e.action === "refund.approved")!.actor_id).toBe(acc2.userId);
      });
    });

    describe("AT16 — retry/timeout: không vượt đã thu, không hoàn trùng", () => {
      async function approvedRefund(amount: number) {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const r = await createRefund(A("accountant"), other(o, amount));
        expect(r.data.refund.state).toBe("approved");
        return { o, id: r.data.refund.id as string };
      }
      const execute = (id: string) => flow.admin(`/admin/x/refunds/${id}/execute`, A("accountant"));

      it("timeout SAU khi cổng đã hoàn → unknown (202) + ngoại lệ; gọi lại → hỏi cổng cùng mã → succeeded, cổng hoàn đúng 1 lần", async () => {
        const { o, id } = await approvedRefund(200_000);
        refundGateway.faults.push("timeout_after_commit");
        const first = await execute(id);
        expect(first).toMatchObject({
          status: 202,
          data: { outcome: "unknown", refund: { state: "unknown" } },
        });
        const ex = await checkout().listOpsExceptions({ order_id: o.orderId, kind: "refund_unknown" });
        expect(ex).toHaveLength(1);
        // Đang chưa rõ vẫn giữ tiền: không mở thêm được quá phần còn lại.
        expect((await createRefund(A("accountant"), other(o, 530_001))).status).toBe(422);

        const second = await execute(id);
        expect(second).toMatchObject({ status: 200, data: { outcome: "succeeded" } });
        expect(refundGateway.executed.size).toBe(1);
        expect(refundGateway.totalRefunded()).toBe(200_000);
        expect(refundGateway.calls).toBe(1); // lần hai chỉ HỎI, không gửi lại
        expect(await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" })).toHaveLength(1);
      });

      it("timeout TRƯỚC khi cổng nhận → gọi lại gửi lại CÙNG mã yêu cầu → succeeded một lần", async () => {
        const { id } = await approvedRefund(150_000);
        refundGateway.faults.push("timeout_before_commit");
        expect((await execute(id)).data.outcome).toBe("unknown");
        const second = await execute(id);
        expect(second.data).toMatchObject({ outcome: "succeeded", refund: { attempts: 2 } });
        expect(refundGateway.executed.size).toBe(1);
        expect(new Set(refundGateway.bodies.map((b) => b.vnp_RequestId)).size).toBe(1);
      });

      it("cổng từ chối → failed (502), tiền vẫn giữ; thử lại cùng mã → succeeded", async () => {
        const { o, id } = await approvedRefund(730_000);
        refundGateway.faults.push("fail");
        const failed = await execute(id);
        expect(failed).toMatchObject({
          status: 502,
          data: { outcome: "failed", refund: { state: "failed" } },
        });
        expect((await createRefund(A("accountant"), other(o, 1))).status).toBe(422);
        const retried = await execute(id);
        expect(retried.data.outcome).toBe("succeeded");
        expect(refundGateway.totalRefunded()).toBe(730_000);
        expect(new Set(refundGateway.bodies.map((b) => b.vnp_RequestId)).size).toBe(1);
      });

      it("3 lệnh thực hiện song song → cổng hoàn đúng một lần", async () => {
        const { o, id } = await approvedRefund(300_000);
        const results = await Promise.all([execute(id), execute(id), execute(id)]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(results.map((r) => r.data.outcome).sort()).toEqual([
          "already_succeeded",
          "already_succeeded",
          "succeeded",
        ]);
        expect(refundGateway.executed.size).toBe(1);
        expect(refundGateway.calls).toBe(1);
        expect(await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" })).toHaveLength(1);
      });

      it("cổng hoàn chưa bật (sandbox/live chưa ủy quyền) → 409, yêu cầu giữ nguyên đã duyệt", async () => {
        setRefundGatewayForTest(new DisabledRefundGateway());
        const { id } = await approvedRefund(100_000);
        const r = await execute(id);
        expect(r).toMatchObject({ status: 409, data: { code: "REFUND_PROVIDER_DISABLED" } });
        expect((await returns().getRefund(id))!.state).toBe("approved");
      });
    });
  },
});
