import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { isNonEmpty } from "@x-shop/domain";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import {
  DisabledRefundGateway,
  MockVnpayRefundGateway,
  setRefundGatewayForTest,
} from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

type Role = "order_staff" | "support" | "warehouse" | "accountant";

/**
 * T-173 (review T-169) — từ chối (`/reject`) hoàn theo trả hàng làm yêu cầu trả kẹt vĩnh viễn: `IDX_x_refund_return_unique`
 * tính cả bản `rejected`, `returnReplacementAmount` chỉ mở lại sau `cancelled`. Server chặn từ chối hoàn có `return_id`
 * (409 `RETURN_REFUND_NOT_REJECTABLE` + hướng dẫn); đường đúng: duyệt → thực hiện (→ `failed`) → hủy → mở lại theo
 * `return_id`. Hoàn hủy đơn/lý do khác vẫn từ chối được như cũ. Sổ tiền luôn giữ S-108 (không hai bản mở, không vượt).
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let mock: MockVnpayRefundGateway;
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
    const A = (role: Role) => staff[role].headers;
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);
    const pg = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);

    const reject = (id: string, headers = A("accountant")) =>
      flow.admin(`/admin/x/refunds/${id}/reject`, headers, { reason: "Không đồng ý số tiền" });
    const approve = (id: string, headers = A("accountant")) =>
      flow.admin(`/admin/x/refunds/${id}/approve`, headers);
    const execute = (id: string, evidence?: string) =>
      flow.admin(
        `/admin/x/refunds/${id}/execute`,
        A("accountant"),
        isNonEmpty(evidence) ? { evidence_ref: evidence } : {},
      );
    const cancel = (id: string) =>
      flow.admin(`/admin/x/refunds/${id}/cancel`, A("accountant"), { reason: "Cổng tắt — chuyển hoàn tay" });
    const auditCount = async (resourceId: string, action: string) =>
      Number(
        (
          (await pg()("audit_log").where({ resource_id: resourceId, action }).count({ n: "*" }).first()) as {
            n: string | number;
          }
        ).n,
      );
    /** Sổ tiền của đơn đọc thẳng DB; luôn kiểm S-108: Σ đã hoàn + Σ đang giữ ≤ Σ đã thu. */
    const moneyOf = async (orderId: string) => {
      const cap = (await pg()("payment_ledger")
        .where({ order_id: orderId, kind: "capture" })
        .whereNull("deleted_at")
        .sum({ s: "amount" })
        .first()) as { s: string | number | null } | undefined;
      const rows = (await pg()("x_refund").where({ order_id: orderId }).select("state", "amount")) as Array<{
        state: string;
        amount: string | number;
      }>;
      const sum = (pred: (state: string) => boolean) =>
        rows.filter((r) => pred(r.state)).reduce((s, r) => s + Number(r.amount), 0);
      const money = {
        captured: Number(cap?.s ?? 0),
        succeeded: sum((st) => st === "succeeded"),
        held: sum((st) => !["succeeded", "rejected", "cancelled"].includes(st)),
        rows: rows.length,
      };
      expect(money.succeeded + money.held).toBeLessThanOrEqual(money.captured);
      return money;
    };
    /** Số bản hoàn còn hiệu lực (không rejected/cancelled) của một yêu cầu trả — không bao giờ quá 1. */
    const liveOfReturn = async (retId: string) =>
      (await pg()("x_refund").where({ return_id: retId }).whereNotIn("state", ["rejected", "cancelled"]))
        .length;

    /**
     * Đơn VNPAY đã giao 1 món 730.000 → trả → kiểm định đạt → hoàn 700.000 ở `requested` (kho tạo): `provider`, hoặc
     * `manual` khi cổng hoàn tắt lúc kiểm định (cùng nhánh với đơn COD — hoàn tay không tự vào `failed`).
     */
    async function inspectedReturnWithRequestedRefund(method: "provider" | "manual" = "provider") {
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
        { order_id: o.orderId, kind: "return", reason: "defective", lines: [{ line_id: line, quantity: 1 }] },
        { "Idempotency-Key": key() },
      );
      expect(created.status).toBe(201);
      const retId = created.data.return.id as string;
      expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
      expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
      if (method === "manual") setRefundGatewayForTest(new DisabledRefundGateway());
      const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
        lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
      });
      expect(inspected.data.refund).toMatchObject({
        reason: "return",
        return_id: retId,
        amount: 700_000,
        method,
        state: "requested",
      });
      return { o, retId, refundId: inspected.data.refund.id as string };
    }

    /** Bước tiếp theo cách hoàn + trạng thái (T-173 review): provider đủ đường hủy/tạo lại; manual chỉ duyệt/thực hiện. */
    const PROVIDER_REQUESTED = ["approve", "execute", "cancel", "recreate"];
    const expectNotRejectable = (
      res: { status: number; data: Record<string, unknown> },
      refundId: string,
      retId: string,
      next: { state: string; steps: string[]; evidence?: boolean } = {
        state: "requested",
        steps: PROVIDER_REQUESTED,
      },
    ) =>
      expect({ status: res.status, data: res.data }).toMatchObject({
        status: 409,
        data: {
          code: "RETURN_REFUND_NOT_REJECTABLE",
          refund_id: refundId,
          return_id: retId,
          state: next.state,
          next_steps: next.steps,
          evidence_required: next.evidence ?? false,
        },
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
      fx = await seedCatalog(container, { stock: { "Đen/S": 20, "Đen/M": 20 } });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      mock = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(mock);
      ip = newIp();
    });

    describe("hoàn theo trả hàng `requested` không từ chối được (yêu cầu trả không kẹt)", () => {
      it("[api5-bfla post /admin/x/refunds/{id}/reject] ca kẹt cũ: kế toán từ chối → 409 có hướng dẫn, không đổi gì; CSKH/kho → 403", async () => {
        const { o, retId, refundId } = await inspectedReturnWithRequestedRefund();
        // Không có refund.approve → 403 trước mọi kiểm khác (không lộ thông tin trạng thái).
        expect((await reject(refundId, A("support"))).status).toBe(403);
        expect((await reject(refundId, A("warehouse"))).status).toBe(403);

        const res = await reject(refundId);
        expectNotRejectable(res, refundId, retId);
        expect(res.headers["content-type"]).toContain("application/problem+json");
        // Không đổi trạng thái, vẫn giữ đúng số kiểm định, không audit "rejected"; yêu cầu trả còn chờ hoàn.
        expect(await returns().getRefund(refundId)).toMatchObject({ state: "requested", rejected_by: null });
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 700_000, rows: 1 });
        expect(await auditCount(refundId, "refund.rejected")).toBe(0);
        expect((await returns().getReturn(retId))!.state).toBe("inspected");

        // Đường thường: duyệt → thực hiện → hoàn đủ, yêu cầu trả đóng.
        expect((await approve(refundId)).data.refund.state).toBe("approved");
        // Đã duyệt: bỏ bước duyệt.
        expectNotRejectable(await reject(refundId), refundId, retId, {
          state: "approved",
          steps: ["execute", "cancel", "recreate"],
        });
        expect((await execute(refundId)).data.outcome).toBe("succeeded");
        expect(mock.totalRefunded()).toBe(700_000);
        expect((await returns().getReturn(retId))!.state).toBe("closed");
        // Đã hoàn (kết thúc): vẫn 409 cùng mã, không còn bước nào.
        expectNotRejectable(await reject(refundId), refundId, retId, { state: "succeeded", steps: [] });
      });

      it("cách mới theo hướng dẫn: cổng tắt → duyệt → thực hiện (failed, chưa gửi) → hủy → mở lại → hoàn tay; không vượt, không hai bản mở", async () => {
        const { o, retId, refundId } = await inspectedReturnWithRequestedRefund();
        expectNotRejectable(await reject(refundId), refundId, retId);

        setRefundGatewayForTest(new DisabledRefundGateway());
        expect((await approve(refundId)).status).toBe(200);
        expect((await execute(refundId)).data.code).toBe("REFUND_PROVIDER_DISABLED");
        expect(await returns().getRefund(refundId)).toMatchObject({ state: "failed", attempts: 0 });
        expectNotRejectable(await reject(refundId), refundId, retId, {
          state: "failed",
          steps: ["execute", "cancel", "recreate"],
        });
        // failed vẫn giữ tiền → chưa mở lại được.
        const acc = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const reopen = (k: string = key()) =>
          flow.admin(
            "/admin/x/refunds",
            acc.headers,
            { order_id: o.orderId, reason: "return", return_id: retId, method: "manual" },
            { "Idempotency-Key": k },
          );
        expect(await reopen()).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });

        expect((await cancel(refundId)).data.refund.state).toBe("cancelled");
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 0, rows: 1 });
        const fresh = await reopen();
        expect(fresh).toMatchObject({
          status: 201,
          data: { refund: { reason: "return", return_id: retId, amount: 700_000, method: "manual" } },
        });
        expect(await liveOfReturn(retId)).toBe(1);
        // Bản mới còn hiệu lực → không mở thêm; hoàn khác vượt phần còn lại → 422.
        expect(await reopen()).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        const extra = await flow.admin(
          "/admin/x/refunds",
          acc.headers,
          { order_id: o.orderId, reason: "other", amount: 30_001, method: "manual", note: "Bù" },
          { "Idempotency-Key": key() },
        );
        expect(extra.status).toBe(422);

        const freshId = fresh.data.refund.id as string;
        if (fresh.data.refund.state === "requested") expect((await approve(freshId)).status).toBe(200);
        expect((await execute(freshId, "CK-T173-001")).data.outcome).toBe("succeeded");
        expect((await returns().getReturn(retId))!.state).toBe("closed");
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 700_000, held: 0, rows: 2 });
        expect(mock.calls).toBe(0);
      });

      it("2 lệnh từ chối ∥ 1 lệnh duyệt cùng lúc → hai từ chối 409 cùng mã, duyệt thắng; một audit duyệt, không bản mở thứ hai", async () => {
        const { o, retId, refundId } = await inspectedReturnWithRequestedRefund();
        const [r1, r2, ok] = await Promise.all([reject(refundId), reject(refundId), approve(refundId)]);
        // Từ chối đọc trạng thái trước hoặc sau khi duyệt thắng → bước tiếp khớp đúng trạng thái nó đã đọc.
        for (const r of [r1, r2]) {
          const approved = r.data.state === "approved";
          expectNotRejectable(r, refundId, retId, {
            state: approved ? "approved" : "requested",
            steps: approved ? ["execute", "cancel", "recreate"] : PROVIDER_REQUESTED,
          });
        }
        expect(ok).toMatchObject({ status: 200, data: { changed: true, refund: { state: "approved" } } });
        expect(await returns().getRefund(refundId)).toMatchObject({ state: "approved" });
        expect(await auditCount(refundId, "refund.approved")).toBe(1);
        expect(await auditCount(refundId, "refund.rejected")).toBe(0);
        expect(await liveOfReturn(retId)).toBe(1);
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 700_000, rows: 1 });
      });
    });

    describe("hoàn tay (manual/COD) và dữ liệu cũ đã `rejected` trước T-173", () => {
      it("manual `requested` → 409 chỉ duyệt + thực hiện kèm chứng từ (không hủy/tạo lại); làm theo → hoàn xong, yêu cầu trả đóng", async () => {
        const { o, retId, refundId } = await inspectedReturnWithRequestedRefund("manual");
        expectNotRejectable(await reject(refundId), refundId, retId, {
          state: "requested",
          steps: ["approve", "execute"],
          evidence: true,
        });
        expect((await approve(refundId)).status).toBe(200);
        expectNotRejectable(await reject(refundId), refundId, retId, {
          state: "approved",
          steps: ["execute"],
          evidence: true,
        });
        // Thiếu chứng từ → 422, vẫn approved (không bao giờ thành failed → không có đường hủy).
        expect((await execute(refundId)).data.code).toBe("VALIDATION");
        expect(await returns().getRefund(refundId)).toMatchObject({ state: "approved" });
        expect((await execute(refundId, "CK-T173-002")).data.outcome).toBe("succeeded");
        expect((await returns().getReturn(retId))!.state).toBe("closed");
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 700_000, held: 0, rows: 1 });
        expectNotRejectable(await reject(refundId), refundId, retId, { state: "succeeded", steps: [] });
        expect(mock.calls).toBe(0);
      });

      it("hoàn theo trả hàng đã `rejected` (trước T-173): từ chối lại → 200 idempotent; gỡ bằng SQL ở RUNBOOK §7 → mở lại theo return_id", async () => {
        const { o, retId, refundId } = await inspectedReturnWithRequestedRefund();
        // Dựng dữ liệu cũ như mã trước T-173 đã ghi (requested → rejected), không qua API mới.
        await pg()("x_refund").where({ id: refundId }).update({
          state: "rejected",
          rejected_by: staff.accountant.userId,
          rejected_at: new Date(),
          reject_reason: "Từ chối trước T-173",
        });
        const again = await reject(refundId);
        expect(again).toMatchObject({ status: 200, data: { refund: { id: refundId, state: "rejected" } } });
        expect(again.data.refund.reject_reason).toBeTruthy();
        expect(await auditCount(refundId, "refund.rejected")).toBe(0);
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 0, rows: 1 });

        const acc = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const reopen = () =>
          flow.admin(
            "/admin/x/refunds",
            acc.headers,
            { order_id: o.orderId, reason: "return", return_id: retId },
            { "Idempotency-Key": key() },
          );
        // Đây là chỗ kẹt: bản rejected vẫn chiếm chỉ mục theo yêu cầu trả.
        expect(await reopen()).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });

        // Câu SQL gỡ ở RUNBOOK §7 (chép nguyên văn) — chỉ khớp bản rejected có return_id.
        const unstick = `UPDATE x_refund SET state='cancelled', cancelled_by=rejected_by, cancelled_at=rejected_at, cancel_reason=coalesce(reject_reason,'legacy reject (T-173)') WHERE id=? AND state='rejected' AND return_id IS NOT NULL`;
        const res = (await pg().raw(unstick, [refundId])) as { rowCount: number };
        expect(res.rowCount).toBe(1);
        expect((await pg().raw(unstick, [refundId])) as { rowCount: number }).toMatchObject({ rowCount: 0 });
        expect(await returns().getRefund(refundId)).toMatchObject({
          state: "cancelled",
          cancelled_by: staff.accountant.userId,
          cancel_reason: "Từ chối trước T-173",
        });

        const fresh = await reopen();
        expect(fresh).toMatchObject({
          status: 201,
          data: { refund: { reason: "return", return_id: retId, amount: 700_000 } },
        });
        expect(await reopen()).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        expect(await liveOfReturn(retId)).toBe(1);
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 700_000, rows: 2 });
      });
    });

    describe("hoàn không theo trả hàng vẫn từ chối được như cũ (đối chứng)", () => {
      it("hoàn hủy đơn `requested` → từ chối nhả tiền → mở lại `cancellation` được; hoàn `other` từ chối được", async () => {
        const o: PlacedOrder = await flow.place([["Đen/M", 1]], "vnpay");
        expect((await flow.cancel(o)).data.cancel.refund_requested).toBe(true);
        const [first] = await returns().listRefundsOfOrder(o.orderId);
        expect(first).toMatchObject({ reason: "cancellation", return_id: null, state: "requested" });
        const rejected = await reject(first!.id);
        expect(rejected).toMatchObject({ status: 200, data: { refund: { state: "rejected" } } });
        expect(await auditCount(first!.id, "refund.rejected")).toBe(1);
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 0, rows: 1 });

        const acc = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["accountant"],
        });
        const again = await flow.admin(
          "/admin/x/refunds",
          acc.headers,
          { order_id: o.orderId, reason: "cancellation" },
          { "Idempotency-Key": key() },
        );
        expect(again).toMatchObject({
          status: 201,
          data: { refund: { reason: "cancellation", amount: 730_000 } },
        });
        expect(await moneyOf(o.orderId)).toEqual({ captured: 730_000, succeeded: 0, held: 730_000, rows: 2 });

        const o2 = await flow.place([["Đen/S", 1]], "vnpay");
        const byCs = await flow.admin(
          "/admin/x/refunds",
          A("support"),
          { order_id: o2.orderId, reason: "other", amount: 50_000, note: "Bù phí ship" },
          { "Idempotency-Key": key() },
        );
        expect(byCs.data.refund.state).toBe("requested");
        expect((await reject(byCs.data.refund.id)).data.refund.state).toBe("rejected");
      });
    });
  },
});
