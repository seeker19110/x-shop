import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_CONFIG } from "../../src/modules/returns/constants";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

type Role = "owner" | "order_staff" | "support" | "warehouse" | "accountant";

/**
 * T-044 — chặn đường vòng duyệt hoàn tiền (S-403, S-108):
 *  1. route native ghi tiền (`/admin/payments/:id/refund|capture`, payment-collections, credit-lines) và hủy đơn native
 *     đóng với MỌI vai trò, kể cả owner — hoàn tiền chỉ qua `/admin/x/refunds`;
 *  2. yêu cầu hoàn `failed` không giữ tiền mãi: hủy (`failed → cancelled`, đối chiếu cổng trước) nhả số đang giữ để tạo
 *     yêu cầu mới; thử lại có giới hạn `refundMaxAttempts`; tổng hoàn ≤ đã thu vẫn giữ, idempotent, đồng thời.
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
    const staff = {} as Record<Role, MfaAdmin>;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);
    const auditOf = () => container.resolve<AuditModuleService>(AUDIT_MODULE);
    const A = (role: Role) => staff[role].headers;
    const createRefund = (headers: Record<string, string>, body: object, k: string = key()) =>
      flow.admin("/admin/x/refunds", headers, body, { "Idempotency-Key": k });
    const other = (o: PlacedOrder, amount: number) => ({
      order_id: o.orderId,
      reason: "other",
      amount,
      note: "Hoàn bù chênh lệch",
    });
    const execute = (id: string) => flow.admin(`/admin/x/refunds/${id}/execute`, A("accountant"));
    const cancel = (
      id: string,
      headers = A("accountant"),
      body: object = { reason: "Cổng từ chối, hoàn tay" },
    ) => flow.admin(`/admin/x/refunds/${id}/cancel`, headers, body);
    const summary = async (o: PlacedOrder) =>
      (await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("accountant"))).data;

    /** Đơn VNPAY đã thu + một yêu cầu hoàn đã duyệt (kế toán, dưới ngưỡng) → cổng từ chối → `failed`. */
    async function failedRefund(amount: number) {
      const o = await flow.place([["Đen/M", 1]], "vnpay");
      const r = await createRefund(A("accountant"), other(o, amount));
      expect(r.data.refund.state).toBe("approved");
      const id = r.data.refund.id as string;
      refundGateway.faults.push("fail");
      expect(await execute(id)).toMatchObject({ status: 502, data: { refund: { state: "failed" } } });
      return { o, id };
    }

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["owner", "order_staff", "support", "warehouse", "accountant"] as const) {
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
      fx = await seedCatalog(container, { stock: { "Đen/S": 20, "Đen/M": 20 } });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      clearShippingFeeCache();
      refundGateway = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(refundGateway);
      ip = newIp();
    });

    describe("route native ghi tiền đóng với mọi vai trò (S-403)", () => {
      async function nativePaymentOf(orderId: string) {
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "order",
          fields: ["id", "payment_collections.id", "payment_collections.payments.id"],
          filters: { id: orderId },
        });
        const pc = (
          data[0] as { payment_collections?: Array<{ id: string; payments?: Array<{ id: string }> }> }
        ).payment_collections?.[0];
        return {
          collectionId: pc?.id ?? "pay_col_khong_co",
          paymentId: pc?.payments?.[0]?.id ?? "pay_khong_co",
        };
      }

      it("kế toán gọi POST /admin/payments/:id/refund (payment thật đã thu) → 403, không hoàn gì; audit lý do", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const { paymentId } = await nativePaymentOf(o.orderId);
        expect(paymentId).toMatch(/^pay_/);
        const res = await flow.admin(`/admin/payments/${paymentId}/refund`, A("accountant"), {
          amount: 100_000,
        });
        expect(res).toMatchObject({ status: 403, data: { code: "FORBIDDEN" } });
        expect(res.headers["content-type"]).toContain("application/problem+json");

        // Không có tiền nào được ghi hoàn: sổ x_refund rỗng, ledger không có bút toán refund, còn hoàn được đủ.
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
        expect(await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" })).toHaveLength(0);
        expect(await summary(o)).toMatchObject({ captured: 730_000, refunded: 0, refundable: 730_000 });
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "payment",
          fields: ["id", "refunds.id"],
          filters: { id: paymentId },
        });
        expect((data[0] as { refunds?: unknown[] }).refunds ?? []).toHaveLength(0);

        const { entries } = await auditOf().list(
          { action: "rbac.denied", actor_id: staff.accountant.userId },
          { limit: 5, offset: 0 },
        );
        expect(entries[0]).toMatchObject({
          resource_id: `POST /admin/payments/${paymentId.toLowerCase()}/refund`,
          changes: { reason: "NATIVE_MONEY_ROUTE" },
        });

        // Đường đúng vẫn mở cho kế toán: /admin/x/refunds (201) và đọc payment native (không 403).
        expect((await createRefund(A("accountant"), other(o, 100_000))).status).toBe(201);
        expect((await flow.adminGet(`/admin/payments/${paymentId}`, A("accountant"))).status).not.toBe(403);
      });

      it("owner (quyết định T-044: chặn hẳn) và mọi vai trò khác: refund/capture/mark-as-paid/credit-lines/hủy native → 403", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const { paymentId, collectionId } = await nativePaymentOf(o.orderId);
        const routes: Array<[string, object]> = [
          [`/admin/payments/${paymentId}/refund`, { amount: 1_000 }],
          [`/admin/payments/${paymentId}/capture`, {}],
          [`/admin/payment-collections/${collectionId}/mark-as-paid`, { order_id: o.orderId }],
          [`/admin/payment-collections`, { order_id: o.orderId, amount: 1_000 }],
          [
            `/admin/orders/${o.orderId}/credit-lines`,
            { amount: 1_000, reference: "order", reference_id: o.orderId },
          ],
          [`/admin/orders/${o.orderId}/cancel`, {}],
        ];
        for (const role of ["owner", "accountant", "order_staff", "support", "warehouse"] as const) {
          for (const [url, body] of routes) {
            const res = await flow.admin(url, A(role), body);
            expect({ role, url, status: res.status, code: res.data.code }).toEqual({
              role,
              url,
              status: 403,
              code: "FORBIDDEN",
            });
          }
        }
        const del = await (rawApi as unknown as { delete: Api["get"] }).delete(
          `/admin/payment-collections/${collectionId}`,
          { headers: A("owner"), validateStatus: () => true },
        );
        expect(del.status).toBe(403);
        // Đơn vẫn nguyên: chưa hủy, chưa hoàn.
        expect((await checkout().listOrderFinances({ order_id: o.orderId }))[0]!.state).toBe("confirmed");
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
        // Owner vẫn hoàn được qua đường có sổ + duyệt (dưới ngưỡng tự duyệt vì có refund.approve).
        const ok = await createRefund(A("owner"), other(o, 50_000));
        expect(ok).toMatchObject({ status: 201, data: { refund: { state: "approved" } } });
      });
    });

    describe("refund failed: hủy nhả tiền giữ, tạo yêu cầu mới, tổng không vượt (S-108)", () => {
      it("failed giữ tiền → hủy (lý do bắt buộc, quyền refund.execute) → tạo yêu cầu mới vừa đủ; không vượt; audit", async () => {
        const { o, id } = await failedRefund(730_000);
        expect(await summary(o)).toMatchObject({ held: 730_000, refundable: 0 });
        expect((await createRefund(A("accountant"), other(o, 1))).status).toBe(422);

        // Quyền: CSKH (refund.request) / kho / nhân viên đơn không hủy được; thiếu lý do → 422.
        for (const role of ["support", "warehouse", "order_staff"] as const) {
          expect({ role, status: (await cancel(id, A(role))).status }).toEqual({ role, status: 403 });
        }
        expect((await cancel(id, A("accountant"), {})).status).toBe(422);
        expect((await cancel(id, A("accountant"), { reason: "x" })).status).toBe(422);
        expect((await returns().getRefund(id))!.state).toBe("failed");

        const done = await cancel(id);
        expect(done).toMatchObject({
          status: 200,
          data: {
            changed: true,
            refund: {
              state: "cancelled",
              cancelled_by: staff.accountant.userId,
              cancel_reason: "Cổng từ chối, hoàn tay",
            },
          },
        });
        // Hủy lại → idempotent.
        expect((await cancel(id)).data).toMatchObject({ changed: false, refund: { state: "cancelled" } });
        expect(await summary(o)).toMatchObject({
          captured: 730_000,
          refunded: 0,
          held: 0,
          refundable: 730_000,
        });

        // Yêu cầu mới: vượt → 422; vừa đủ → 201; thêm 1 đồng → 422.
        expect((await createRefund(A("accountant"), other(o, 730_001))).status).toBe(422);
        const fresh = await createRefund(A("accountant"), other(o, 730_000));
        expect(fresh).toMatchObject({ status: 201, data: { refund: { state: "approved" } } });
        expect((await createRefund(A("accountant"), other(o, 1))).status).toBe(422);

        // Bản đã hủy không thực hiện được nữa; bản mới hoàn qua cổng (giao dịch gốc được nhả chỗ) đúng một lần.
        expect(await execute(id)).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        expect((await execute(fresh.data.refund.id)).data.outcome).toBe("succeeded");
        expect(refundGateway.totalRefunded()).toBe(730_000);
        expect(await summary(o)).toMatchObject({ refunded: 730_000, held: 0, refundable: 0 });

        const { entries } = await auditOf().list(
          { resource_type: "refund", resource_id: id },
          { limit: 10, offset: 0 },
        );
        const cancelled = entries.filter((e) => e.action === "refund.cancelled");
        expect(cancelled).toHaveLength(1);
        expect(cancelled[0]).toMatchObject({
          actor_id: staff.accountant.userId,
          reason: "Cổng từ chối, hoàn tay",
        });
      });

      it("chỉ hủy được bản failed: approved/succeeded → 409; không có → 404", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const r = await createRefund(A("accountant"), other(o, 100_000));
        const id = r.data.refund.id as string;
        expect(await cancel(id)).toMatchObject({
          status: 409,
          data: { code: "INVALID_STATE", state: "approved" },
        });
        expect((await execute(id)).data.outcome).toBe("succeeded");
        expect(await cancel(id)).toMatchObject({ status: 409, data: { state: "succeeded" } });
        expect((await cancel("xrfd_khong_co")).status).toBe(404);
      });

      it("đối chiếu trước khi hủy: cổng thực ra đã hoàn → chốt succeeded, KHÔNG hủy (không mở được yêu cầu trùng)", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const r = await createRefund(A("accountant"), other(o, 200_000));
        const id = r.data.refund.id as string;
        // Cổng đã hoàn nhưng phản hồi mất; bản ghi lệch về failed (vd. đối chiếu sai trước đó) — tình huống xấu nhất.
        refundGateway.faults.push("timeout_after_commit");
        expect((await execute(id)).data.outcome).toBe("unknown");
        await returns().updateRefund(null, id, ["unknown"], { state: "failed", last_error: "simulated" });

        const res = await cancel(id);
        expect(res).toMatchObject({ status: 409, data: { code: "INVALID_STATE", state: "succeeded" } });
        expect((await returns().getRefund(id))!.state).toBe("succeeded");
        expect(await summary(o)).toMatchObject({ refunded: 200_000, held: 0, refundable: 530_000 });
        expect(await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" })).toHaveLength(1);
        expect((await createRefund(A("accountant"), other(o, 530_001))).status).toBe(422);
        expect(refundGateway.totalRefunded()).toBe(200_000);
      });

      it("hoàn hủy đơn (cancellation) failed → hủy → mở lại yêu cầu hủy đơn được (chỉ mục duy nhất bỏ qua bản cancelled)", async () => {
        const acc = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        expect((await flow.cancel(o)).data.cancel.refund_requested).toBe(true);
        const [first] = await returns().listRefundsOfOrder(o.orderId);
        expect(first).toMatchObject({ reason: "cancellation", amount: 730_000, state: "requested" });
        expect((await flow.admin(`/admin/x/refunds/${first!.id}/approve`, acc.headers)).status).toBe(200);
        refundGateway.faults.push("fail");
        expect((await flow.admin(`/admin/x/refunds/${first!.id}/execute`, acc.headers)).status).toBe(502);
        // Còn hiệu lực → không mở được yêu cầu hủy đơn thứ hai.
        const dup = await createRefund(acc.headers, { order_id: o.orderId, reason: "cancellation" });
        expect(dup.status).toBe(422);

        expect((await cancel(first!.id, acc.headers)).data.refund.state).toBe("cancelled");
        const again = await createRefund(acc.headers, {
          order_id: o.orderId,
          reason: "cancellation",
          method: "manual",
        });
        expect(again).toMatchObject({
          status: 201,
          data: { refund: { reason: "cancellation", amount: 730_000, method: "manual", state: "approved" } },
        });
        expect((await createRefund(acc.headers, other(o, 1))).status).toBe(422);
        const paid = await flow.admin(`/admin/x/refunds/${again.data.refund.id}/execute`, acc.headers, {
          evidence_ref: "CK-T044-0001",
        });
        expect(paid.data.outcome).toBe("succeeded");
        expect(await summary(o)).toMatchObject({
          captured: 730_000,
          refunded: 730_000,
          held: 0,
          refundable: 0,
        });
      });
    });

    describe("hoàn theo trả hàng failed → hủy → mở lại theo kiểm định (yêu cầu trả không kẹt)", () => {
      async function inspectedReturnWithFailedRefund() {
        const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "order",
          fields: ["id", "items.id", "items.variant_id"],
          filters: { id: o.orderId },
        });
        const line = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items.find(
          (i) => i.variant_id === fx.variants["Đen/M"]!.id,
        )!.id;
        const created = await flow.admin(
          "/admin/x/returns",
          A("support"),
          {
            order_id: o.orderId,
            kind: "return",
            reason: "defective",
            lines: [{ line_id: line, quantity: 1 }],
          },
          { "Idempotency-Key": key() },
        );
        expect(created.status).toBe(201);
        const retId = created.data.return.id as string;
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.data.refund).toMatchObject({
          amount: 700_000,
          method: "provider",
          state: "requested",
        });
        const refundId = inspected.data.refund.id as string;
        expect((await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("accountant"))).status).toBe(200);
        refundGateway.faults.push("fail");
        expect((await execute(refundId)).data.refund.state).toBe("failed");
        // Mở lại không gửi số tiền → route đòi MFA gần đây (≤ 5 phút): kế toán đăng nhập mới cho ca này.
        acc = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: ["accountant"] });
        return { o, retId, refundId };
      }
      let acc: MfaAdmin;
      const reopen = (o: PlacedOrder, retId: string, extra: object = {}, k: string = key()) =>
        createRefund(acc.headers, { order_id: o.orderId, reason: "return", return_id: retId, ...extra }, k);

      it("còn hiệu lực → không mở lại (409); hủy → mở lại đúng số kiểm định, hoàn xong thì đóng yêu cầu trả", async () => {
        const { o, retId, refundId } = await inspectedReturnWithFailedRefund();
        expect(await reopen(o, retId)).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        expect((await cancel(refundId)).data.refund.state).toBe("cancelled");
        expect(await summary(o)).toMatchObject({ held: 0, refundable: 730_000 });

        // Client không tự đặt số tiền; return_id sai đơn/không có → 404; return_id với lý do khác → 422.
        expect((await reopen(o, retId, { amount: 1 })).status).toBe(422);
        expect((await reopen(o, "xret_khong_co")).status).toBe(404);
        expect((await createRefund(A("accountant"), { ...other(o, 1_000), return_id: retId })).status).toBe(
          422,
        );
        // Không có refund.request (kho) → 403.
        expect(
          (await createRefund(A("warehouse"), { order_id: o.orderId, reason: "return", return_id: retId }))
            .status,
        ).toBe(403);

        const k = key();
        const fresh = await reopen(o, retId, {}, k);
        expect(fresh).toMatchObject({
          status: 201,
          data: { refund: { reason: "return", return_id: retId, amount: 700_000, state: "approved" } },
        });
        // Gửi lại cùng khóa → bản cũ; khóa mới → 409 (đã có bản hiệu lực); tổng không vượt.
        expect((await reopen(o, retId, {}, k)).status).toBe(200);
        expect(await reopen(o, retId)).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        expect((await createRefund(A("accountant"), other(o, 30_001))).status).toBe(422);

        expect((await execute(fresh.data.refund.id)).data.outcome).toBe("succeeded");
        expect(refundGateway.totalRefunded()).toBe(700_000);
        expect((await returns().getReturn(retId))!.state).toBe("closed");
        expect(await summary(o)).toMatchObject({ refunded: 700_000, held: 0, refundable: 30_000 });
      });

      it("2 lần mở lại song song (khóa khác nhau) → đúng một bản", async () => {
        const { o, retId, refundId } = await inspectedReturnWithFailedRefund();
        await cancel(refundId);
        const results = await Promise.all([reopen(o, retId), reopen(o, retId)]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        const active = (await returns().listRefundsOfOrder(o.orderId)).filter((r) => r.state !== "cancelled");
        expect(active).toHaveLength(1);
        expect(await summary(o)).toMatchObject({ held: 700_000, refundable: 30_000 });
      });
    });

    describe("thử lại có giới hạn (refundMaxAttempts)", () => {
      it(`failed → processing tối đa ${RETURNS_CONFIG.refundMaxAttempts} lần gửi; quá → 409 REFUND_RETRY_EXHAUSTED, cổng không bị gọi thêm; hủy rồi tạo mới`, async () => {
        const max = RETURNS_CONFIG.refundMaxAttempts;
        expect(max).toBeGreaterThanOrEqual(1);
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const r = await createRefund(A("accountant"), other(o, 100_000));
        const id = r.data.refund.id as string;
        for (let i = 1; i <= max; i++) {
          refundGateway.faults.push("fail");
          const res = await execute(id);
          expect({ i, status: res.status, attempts: res.data.refund?.attempts }).toEqual({
            i,
            status: 502,
            attempts: i,
          });
        }
        const calls = refundGateway.calls;
        const exhausted = await execute(id);
        expect(exhausted).toMatchObject({
          status: 409,
          data: { code: "REFUND_RETRY_EXHAUSTED", attempts: max, max_attempts: max },
        });
        expect(refundGateway.calls).toBe(calls);
        expect(new Set(refundGateway.bodies.map((b) => b.vnp_RequestId)).size).toBe(1);
        expect((await returns().getRefund(id))!).toMatchObject({ state: "failed", attempts: max });

        expect((await cancel(id)).data.refund.state).toBe("cancelled");
        const fresh = await createRefund(A("accountant"), other(o, 100_000));
        expect(fresh.status).toBe(201);
        expect((await execute(fresh.data.refund.id)).data).toMatchObject({
          outcome: "succeeded",
          refund: { attempts: 1 },
        });
        expect(refundGateway.totalRefunded()).toBe(100_000);
      });

      it("còn lượt: failed lần 1 → thử lại cùng mã thành công (attempts 2)", async () => {
        const { id } = await failedRefund(150_000);
        const ok = await execute(id);
        expect(ok.data).toMatchObject({ outcome: "succeeded", refund: { attempts: 2 } });
        expect(new Set(refundGateway.bodies.map((b) => b.vnp_RequestId)).size).toBe(1);
      });
    });

    describe("đồng thời", () => {
      it("2 lệnh hủy song song → một changed, một trả nguyên; audit một lần", async () => {
        const { o, id } = await failedRefund(300_000);
        const results = await Promise.all([cancel(id), cancel(id)]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(results.map((r) => r.data.changed).sort()).toEqual([false, true]);
        const { entries } = await auditOf().list(
          { action: "refund.cancelled", resource_id: id },
          { limit: 10, offset: 0 },
        );
        expect(entries).toHaveLength(1);
        expect(await summary(o)).toMatchObject({ held: 0, refundable: 730_000 });
      });

      it("hủy ∥ thử lại cùng lúc → đúng một bên thắng: hoặc đã hoàn (hủy 409) hoặc đã hủy (thực hiện 409); không hoàn trùng", async () => {
        const { o, id } = await failedRefund(400_000);
        const [c, e] = await Promise.all([cancel(id), execute(id)]);
        const row = (await returns().getRefund(id))!;
        if (row.state === "cancelled") {
          expect({ c: c.status, e: e.status, code: e.data.code }).toEqual({
            c: 200,
            e: 409,
            code: "INVALID_STATE",
          });
          expect(refundGateway.totalRefunded()).toBe(0);
          expect(await summary(o)).toMatchObject({ held: 0, refunded: 0, refundable: 730_000 });
        } else {
          expect(row.state).toBe("succeeded");
          expect({ c: c.status, e: e.status }).toEqual({ c: 409, e: 200 });
          expect(refundGateway.totalRefunded()).toBe(400_000);
          expect(await summary(o)).toMatchObject({ held: 0, refunded: 400_000, refundable: 330_000 });
        }
      });
    });
  },
});
