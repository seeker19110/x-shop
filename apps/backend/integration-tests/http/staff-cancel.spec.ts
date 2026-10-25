import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { reservationsOf, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

type Role = "owner" | "order_staff" | "support" | "warehouse" | "accountant";

/**
 * T-044 — nhân viên quyền `order.cancel` hủy đơn qua POST /admin/x/orders/:id/cancel (route native đã đóng), dùng lại
 * lõi hủy của khách (D-012): COD chưa thu → hủy + nhả hàng; VNPAY đã thu → order_finance=cancelled + nhả reservation +
 * mở refund_request (người tạo = nhân viên, chờ người thứ hai duyệt); đã có vận đơn → 409. Lý do bắt buộc, audit,
 * Idempotency-Key; đồng thời chỉ hủy một lần.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
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
    const REASON = "Khách gọi hotline xin hủy";
    const staffCancel = (
      o: PlacedOrder | string,
      headers: Record<string, string> = A("order_staff"),
      k: string | null = key(),
      body: object = { reason: REASON },
    ) =>
      flow.admin(
        `/admin/x/orders/${typeof o === "string" ? o : o.orderId}/cancel`,
        headers,
        body,
        k === null ? {} : { "Idempotency-Key": k },
      );
    const finState = async (o: PlacedOrder) =>
      (await checkout().listOrderFinances({ order_id: o.orderId }))[0]!.state;
    const cancelEvents = (o: PlacedOrder) =>
      checkout().listOutboxEvents({ aggregate_id: o.orderId, type: "order.cancelled" });

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
      setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
      ip = newIp();
    });

    describe("nhân viên đơn hủy được", () => {
      it("COD chưa thu: hủy + nhả hàng + hủy đơn native; không mở hoàn tiền; audit có lý do; khách thấy 'Cửa hàng đã hủy'", async () => {
        const o = await flow.place([["Đen/S", 2]], "cod");
        expect(await finState(o)).toBe("confirmed");
        expect(await reservationsOf(container, fx, "Đen/S")).not.toHaveLength(0);

        const res = await staffCancel(o);
        expect(res).toMatchObject({
          status: 200,
          data: {
            order_id: o.orderId,
            state: "cancelled",
            cancel: { outcome: "cancelled", refund_requested: false, refund_id: null },
          },
        });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(0);
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).toBe("canceled");
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
        expect(
          await checkout().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" }),
        ).toHaveLength(0);
        const events = await cancelEvents(o);
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({
          reason: "SHOP_CANCELLED",
          from: "confirmed",
          refund_amount: 0,
        });

        const { entries } = await auditOf().list(
          { action: "order.cancelled", resource_id: o.orderId },
          { limit: 5, offset: 0 },
        );
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          actor_id: staff.order_staff.userId,
          resource_type: "order",
          reason: REASON,
          changes: { by: "staff", from: "confirmed", to: "cancelled", refund_amount: 0 },
        });

        const view = await api.get(`/store/x/orders/${o.ref}`, {
          headers: {
            "x-publishable-api-key": fx.publishableKey,
            "x-order-access": o.access,
            "x-forwarded-for": ip,
          },
        });
        expect(view.data).toMatchObject({ state: "cancelled", cancel_reason: "SHOP_CANCELLED" });
      });

      it("VNPAY đã thu: order_finance=cancelled + nhả reservation + refund_request; yêu cầu hoàn do nhân viên tạo, người khác duyệt", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const res = await staffCancel(o);
        expect(res.status).toBe(200);
        expect(res.data.cancel).toMatchObject({ outcome: "cancelled", refund_requested: true });
        const refundId = res.data.cancel.refund_id as string;
        expect(refundId).toMatch(/^xrfd_/);

        expect(await finState(o)).toBe("cancelled");
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        // D-012: đơn native chỉ hủy khi tiền đã hoàn thật.
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).not.toBe("canceled");
        const ex = await checkout().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" });
        expect(ex).toHaveLength(1);
        expect(ex[0]).toMatchObject({ amount: 730_000, state: "open" });
        expect(ex[0]!.detail).toMatchObject({ reason: "SHOP_CANCELLED" });

        const refunds = await returns().listRefundsOfOrder(o.orderId);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({
          id: refundId,
          reason: "cancellation",
          amount: 730_000,
          state: "requested",
          requested_by: staff.order_staff.userId,
        });
        // Nhân viên đơn không duyệt/thực hiện được (không có quyền); kế toán (người khác) duyệt rồi thực hiện.
        expect((await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("order_staff"))).status).toBe(403);
        expect((await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("accountant"))).status).toBe(200);
        const exec = await flow.admin(`/admin/x/refunds/${refundId}/execute`, A("accountant"));
        expect(exec.data.outcome).toBe("succeeded");
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).toBe("canceled");
      });

      it("owner hủy được; owner tạo yêu cầu hoàn thì vẫn không tự duyệt (cần người thứ hai)", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const res = await staffCancel(o, A("owner"));
        expect(res.data.cancel).toMatchObject({ outcome: "cancelled", refund_requested: true });
        const refundId = res.data.cancel.refund_id as string;
        const self = await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("owner"));
        expect(self).toMatchObject({ status: 403, data: { code: "SELF_APPROVAL" } });
      });
    });

    describe("bị từ chối", () => {
      it("CSKH / kho / kế toán (không có order.cancel) → 403; route native hủy đơn → 403 kể cả nhân viên đơn", async () => {
        const o = await flow.place([["Đen/S", 1]], "cod");
        for (const role of ["support", "warehouse", "accountant"] as const) {
          const res = await staffCancel(o, A(role));
          expect({ role, status: res.status, code: res.data.code }).toEqual({
            role,
            status: 403,
            code: "FORBIDDEN",
          });
        }
        const native = await flow.admin(`/admin/orders/${o.orderId}/cancel`, A("order_staff"));
        expect(native.status).toBe(403);
        expect(await finState(o)).toBe("confirmed");
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).not.toBe("canceled");
      });

      it("đơn đã có vận đơn → 409 NOT_CANCELLABLE, đơn giữ nguyên, không ghi lệnh hủy", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        expect((await flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("order_staff"))).status).toBe(
          201,
        );
        const k = key();
        const res = await staffCancel(o, A("order_staff"), k);
        expect(res).toMatchObject({ status: 409, data: { code: "NOT_CANCELLABLE" } });
        expect(await finState(o)).toBe("confirmed");
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(0);
        expect(await returns().findOrderCancelByKey(`staff:${k}`)).toBeNull();
      });

      it("thiếu/ngắn lý do, thiếu/sai Idempotency-Key → 422; đơn không có → 404", async () => {
        const o = await flow.place([["Đen/S", 1]], "cod");
        expect((await staffCancel(o, A("order_staff"), key(), {})).status).toBe(422);
        expect((await staffCancel(o, A("order_staff"), key(), { reason: "  " })).status).toBe(422);
        expect((await staffCancel(o, A("order_staff"), key(), { reason: "x".repeat(501) })).status).toBe(422);
        expect((await staffCancel(o, A("order_staff"), key(), { reason: REASON, extra: 1 })).status).toBe(
          422,
        );
        expect((await staffCancel(o, A("order_staff"), null)).status).toBe(422);
        expect((await staffCancel(o, A("order_staff"), "ngan")).status).toBe(422);
        expect(await finState(o)).toBe("confirmed");
        expect((await staffCancel("order_khong_co", A("order_staff"))).status).toBe(404);
      });
    });

    describe("idempotency + đồng thời", () => {
      it("gửi lại cùng Idempotency-Key → kết quả cũ (replayed), không hủy 2 lần; khác nội dung → 409; khóa mới → already_cancelled", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const k = key();
        const first = await staffCancel(o, A("order_staff"), k);
        expect(first.data.cancel.outcome).toBe("cancelled");
        const again = await staffCancel(o, A("order_staff"), k);
        expect(again.status).toBe(200);
        expect(again.headers["idempotent-replayed"]).toBe("true");
        expect(again.data.cancel).toEqual(first.data.cancel);

        const conflict = await staffCancel(o, A("order_staff"), k, { reason: "Lý do khác hẳn" });
        expect(conflict).toMatchObject({ status: 409, data: { code: "IDEMPOTENCY_CONFLICT" } });
        const fresh = await staffCancel(o, A("order_staff"), key());
        expect(fresh.data.cancel).toMatchObject({
          outcome: "already_cancelled",
          refund_requested: true,
          refund_id: first.data.cancel.refund_id,
        });

        expect(await cancelEvents(o)).toHaveLength(1);
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(1);
        expect(
          await checkout().listOpsExceptions({ order_id: o.orderId, kind: "refund_request" }),
        ).toHaveLength(1);
        const { entries } = await auditOf().list(
          { action: "order.cancelled", resource_id: o.orderId },
          { limit: 5, offset: 0 },
        );
        expect(entries).toHaveLength(1);
      });

      it("2 lệnh hủy song song (khóa khác nhau) → đúng 1 cancelled; cùng khóa ×3 song song → 1 lần hủy, còn lại replay", async () => {
        const a = await flow.place([["Đen/M", 1]], "vnpay");
        const two = await Promise.all([staffCancel(a), staffCancel(a, A("owner"))]);
        expect(two.map((r) => r.status)).toEqual([200, 200]);
        expect(two.map((r) => r.data.cancel.outcome).sort()).toEqual(["already_cancelled", "cancelled"]);
        expect(await cancelEvents(a)).toHaveLength(1);
        expect(await returns().listRefundsOfOrder(a.orderId)).toHaveLength(1);
        const { entries } = await auditOf().list(
          { action: "order.cancelled", resource_id: a.orderId },
          { limit: 5, offset: 0 },
        );
        expect(entries).toHaveLength(1);

        const b = await flow.place([["Đen/S", 1]], "cod");
        const k = key();
        const three = await Promise.all([1, 2, 3].map(() => staffCancel(b, A("order_staff"), k)));
        expect(three.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(three.map((r) => r.data.cancel.outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
        expect(three.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(2);
        expect(await cancelEvents(b)).toHaveLength(1);
        expect(await finState(b)).toBe("cancelled");
      });

      it("khách hủy ∥ nhân viên hủy cùng lúc → một lần hủy, một yêu cầu hoàn", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const [c, s] = await Promise.all([flow.cancel(o), staffCancel(o)]);
        expect([c.status, s.status]).toEqual([200, 200]);
        expect([c.data.cancel.outcome, s.data.cancel.outcome].sort()).toEqual([
          "already_cancelled",
          "cancelled",
        ]);
        expect(await cancelEvents(o)).toHaveLength(1);
        expect(await returns().listRefundsOfOrder(o.orderId)).toHaveLength(1);
      });
    });
  },
});
