import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import {
  DisabledRefundGateway,
  MockVnpayRefundGateway,
  setRefundGatewayForTest,
  type ProviderRefundRequest,
  type ProviderRefundResult,
  type RefundGateway,
} from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/** Cổng hoàn bật nhưng mọi lần gửi ném lỗi (HTTP 5xx / đứt mạng) — kết quả mơ hồ, KHÔNG phải từ chối dứt khoát. */
class ThrowingRefundGateway implements RefundGateway {
  readonly enabled = true;
  calls = 0;
  async refund(): Promise<ProviderRefundResult> {
    this.calls += 1;
    throw new Error("HTTP 503 Service Unavailable");
  }
  async query(_req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    throw new Error("HTTP 503 Service Unavailable");
  }
}

/**
 * T-169 (review T-168 R1/R2) — hoàn VNPAY khi cổng hoàn TẮT (sandbox/live chưa ủy quyền) hoặc khoản thu không hoàn qua cổng
 * được: `auto` chọn `manual` có lý do; `provider` bị cổng/hệ thống từ chối dứt khoát (409 disabled, 422 không có giao dịch
 * gốc) → `failed` có lý do, hủy được, nhả số giữ; lỗi tạm (timeout/5xx) → GIỮ NGUYÊN (không nhả khi chưa chắc cổng chưa
 * hoàn); attempt `captured` + giao dịch thành công thứ hai khác mã → `payment_unknown` `attempt_txn_conflict`.
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
    const staff = {} as Record<"order_staff" | "support" | "warehouse" | "accountant" | "owner", MfaAdmin>;
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const A = (role: keyof typeof staff) => staff[role].headers;
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);
    const pg = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const disable = () => setRefundGatewayForTest(new DisabledRefundGateway());
    const enable = () => setRefundGatewayForTest(mock);

    const createRefund = (body: object, k: string = key()) =>
      flow.admin("/admin/x/refunds", A("accountant"), body, { "Idempotency-Key": k });
    const execute = (id: string, evidence?: string) =>
      flow.admin(
        `/admin/x/refunds/${id}/execute`,
        A("accountant"),
        evidence ? { evidence_ref: evidence } : {},
      );
    const cancel = (id: string) =>
      flow.admin(`/admin/x/refunds/${id}/cancel`, A("accountant"), { reason: "Cổng tắt — chuyển hoàn tay" });
    const other = (o: PlacedOrder, amount: number, method: string) => ({
      order_id: o.orderId,
      reason: "other",
      amount,
      method,
      note: "Hoàn bù chênh lệch",
    });
    const row = async (id: string) => (await returns().getRefund(id))!;
    const exceptions = (orderId: string, kind: "late_payment" | "payment_unknown" | "overpayment") =>
      checkout().listOpsExceptions({ order_id: orderId, kind });
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
    const auditCount = async (resourceId: string, action: string) =>
      Number(
        (
          (await pg()("audit_log").where({ resource_id: resourceId, action }).count({ n: "*" }).first()) as {
            n: string | number;
          }
        ).n,
      );

    /** Đơn VNPAY đã thu + yêu cầu hoàn `provider` đã duyệt, tạo khi cổng (mock) còn bật. */
    async function approvedProviderRefund(variant = "Đen/M") {
      const o = await flow.place([[variant, 1]], "vnpay");
      const created = await createRefund(other(o, o.total, "provider"));
      expect(created.status).toBe(201);
      expect(created.data.refund).toMatchObject({ method: "provider", state: "approved" });
      return { o, id: String(created.data.refund.id) };
    }

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "accountant", "owner"] as const) {
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
      mock = new MockVnpayRefundGateway(DEV_VNPAY);
      enable();
      ip = newIp();
    });

    describe("cổng hoàn TẮT (sandbox/live) — `auto` chọn hoàn tay ngay khi tạo", () => {
      it("R1 auto: kế toán tạo `auto` → `manual` + lý do provider_disabled; hoàn tay có chứng từ → succeeded, không kẹt", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        disable();
        const created = await createRefund(other(o, o.total, "auto"));
        expect(created.status).toBe(201);
        expect(created.data.refund).toMatchObject({
          method: "manual",
          provider: "manual",
          state: "approved",
        });
        expect(created.data.refund.note).toContain("provider_disabled");
        expect(created.data.refund.note).toContain("Hoàn bù chênh lệch");
        const exec = await execute(created.data.refund.id, "CK-T169-001");
        expect(exec.data).toMatchObject({ outcome: "succeeded", refund: { state: "succeeded" } });
        expect(await moneyOf(o.orderId)).toEqual({ captured: o.total, succeeded: o.total, held: 0, rows: 1 });
      });

      it("R1 provider: chọn `provider` khi cổng tắt → 409 REFUND_PROVIDER_DISABLED ngay khi tạo, không giữ tiền; `manual` tạo được", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        disable();
        const created = await createRefund(other(o, o.total, "provider"));
        expect({ status: created.status, code: created.data.code }).toEqual({
          status: 409,
          code: "REFUND_PROVIDER_DISABLED",
        });
        expect(await moneyOf(o.orderId)).toEqual({ captured: o.total, succeeded: 0, held: 0, rows: 0 });
        expect((await createRefund(other(o, o.total, "manual"))).status).toBe(201);
      });

      it("hủy đơn đã thu (refund hệ thống tạo, `auto`) → `manual` + lý do; duyệt + hoàn tay → succeeded, tiền không kẹt", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        disable();
        expect((await flow.cancel(o)).data.cancel).toEqual({ outcome: "cancelled", refund_requested: true });
        const [r] = await returns().listRefundsOfOrder(o.orderId);
        expect(r).toMatchObject({
          reason: "cancellation",
          method: "manual",
          provider: "manual",
          capture_ref: null,
        });
        expect(r!.note).toContain("provider_disabled");
        expect((await flow.admin(`/admin/x/refunds/${r!.id}/approve`, A("accountant"))).status).toBe(200);
        const exec = await execute(r!.id, "CK-T169-002");
        expect(exec.data.outcome).toBe("succeeded");
        expect(mock.calls).toBe(0);
        expect(await moneyOf(o.orderId)).toEqual({ captured: o.total, succeeded: o.total, held: 0, rows: 1 });
      });

      it("trả hàng (refund hệ thống tạo khi kiểm định, `auto`) → `manual` + lý do; hoàn tay → succeeded, yêu cầu trả đóng", async () => {
        const o = await flow.deliveredOrder([["Trắng/S", 1]], "vnpay");
        const [line] = (await flow.storeReturns(o)).data.lines as J[];
        const req = await flow.requestReturn(o, {
          kind: "return",
          reason: "changed_mind",
          lines: [{ line_id: line!.line_id, quantity: 1 }],
        });
        expect(req.status).toBe(201);
        const retId = String(req.data.return.id);
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
        disable();
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line!.line_id, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.status).toBe(200);
        expect(inspected.data.refund).toMatchObject({
          reason: "return",
          method: "manual",
          provider: "manual",
        });
        expect(inspected.data.refund.note).toContain("provider_disabled");
        const id = String(inspected.data.refund.id);
        expect((await flow.admin(`/admin/x/refunds/${id}/approve`, A("accountant"))).status).toBe(200);
        expect((await execute(id, "CK-T169-003")).data.outcome).toBe("succeeded");
        expect((await returns().getReturn(retId))!.state).toBe("closed");
        expect(mock.calls).toBe(0);
      });

      it("cổng BẬT: `auto` vẫn chọn `provider`, ghi chú giữ nguyên (đối chứng)", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const created = await createRefund(other(o, o.total, "auto"));
        expect(created.data.refund).toMatchObject({ method: "provider", note: "Hoàn bù chênh lệch" });
      });
    });

    describe("`provider` bị từ chối dứt khoát lúc thực hiện → failed, hủy được, nhả tiền", () => {
      it("R1: tạo khi cổng bật, cổng tắt trước khi thực hiện → 409 + `failed` (provider_disabled, chưa gửi lần nào); hủy → nhả; hoàn tay đủ số", async () => {
        const { o, id } = await approvedProviderRefund();
        disable();
        const exec = await execute(id);
        expect({ status: exec.status, code: exec.data.code }).toEqual({
          status: 409,
          code: "REFUND_PROVIDER_DISABLED",
        });
        expect(await row(id)).toMatchObject({
          state: "failed",
          last_error: "provider_disabled",
          attempts: 0,
        });
        // Còn giữ tới khi hủy (failed = chờ thử lại cùng yêu cầu) — chưa tạo hoàn tay vượt được.
        expect((await createRefund(other(o, o.total, "manual"))).data.code).toBe("REFUND_EXCEEDS_CAPTURED");
        // Thực hiện lại khi cổng vẫn tắt: vẫn 409, không tăng lượt.
        expect((await execute(id)).data.code).toBe("REFUND_PROVIDER_DISABLED");
        expect(await row(id)).toMatchObject({ state: "failed", attempts: 0 });

        const cancelled = await cancel(id);
        expect(cancelled).toMatchObject({ status: 200, data: { refund: { state: "cancelled" } } });
        expect(await moneyOf(o.orderId)).toEqual({ captured: o.total, succeeded: 0, held: 0, rows: 1 });
        const manual = await createRefund(other(o, o.total, "manual"));
        expect(manual.status).toBe(201);
        expect((await execute(manual.data.refund.id, "CK-T169-004")).data.outcome).toBe("succeeded");
        expect(await moneyOf(o.orderId)).toEqual({ captured: o.total, succeeded: o.total, held: 0, rows: 2 });
        expect(mock.calls).toBe(0);
      });

      it("R1: 3 lệnh thực hiện song song khi cổng tắt → cùng 409, một lần chuyển `failed` (một audit)", async () => {
        const { id } = await approvedProviderRefund();
        disable();
        const rs = await Promise.all([execute(id), execute(id), execute(id)]);
        expect(rs.map((r) => `${r.status}:${r.data.code}`)).toEqual(
          Array(3).fill("409:REFUND_PROVIDER_DISABLED"),
        );
        expect(await row(id)).toMatchObject({ state: "failed", attempts: 0 });
        expect(await auditCount(id, "refund.failed")).toBe(1);
      });

      it("422: yêu cầu cổng không còn giao dịch gốc (bản ghi cũ trỏ khoản thu không gắn attempt) → `failed` (method_unavailable); hủy → nhả", async () => {
        const { o, id } = await approvedProviderRefund();
        // Bản ghi do mã cũ tạo cho khoản thu không gắn attempt (R2 trước T-169): đổi giao dịch gốc sang mã không có attempt.
        await pg()("x_refund").where({ id }).update({ capture_ref: "TXN-KHONG-GAN-ATTEMPT" });
        const exec = await execute(id);
        expect({ status: exec.status, code: exec.data.code }).toEqual({
          status: 422,
          code: "REFUND_METHOD_UNAVAILABLE",
        });
        expect(await row(id)).toMatchObject({
          state: "failed",
          last_error: "method_unavailable",
          attempts: 0,
        });
        expect((await cancel(id)).data.refund.state).toBe("cancelled");
        expect(await moneyOf(o.orderId)).toMatchObject({ held: 0, succeeded: 0 });
        expect(mock.calls).toBe(0);
      });

      it("đồng thời: `failed` (chưa gửi) → cổng bật lại → thực hiện ‖ hủy song song: đúng một bên thắng, cổng hoàn ≤ 1 lần; hai hoàn tay song song không vượt", async () => {
        const { o, id } = await approvedProviderRefund();
        disable();
        expect((await execute(id)).status).toBe(409);
        enable();
        mock.captured.set(
          (await checkout().listPaymentAttempts({ order_id: o.orderId }))[0]!.txn_ref,
          o.total,
        );
        const [exec, cancelled] = await Promise.all([execute(id), cancel(id)]);
        const sig = [
          `${exec.status}:${exec.data.outcome ?? exec.data.code}`,
          `${cancelled.status}:${cancelled.data.code ?? "ok"}`,
        ];
        expect([
          ["200:succeeded", "409:INVALID_STATE"],
          ["409:INVALID_STATE", "200:ok"],
        ]).toContainEqual(sig);
        const won = (await row(id)).state;
        expect(mock.totalRefunded()).toBe(won === "succeeded" ? o.total : 0);
        const manuals = await Promise.all([
          createRefund(other(o, o.total, "manual")),
          createRefund(other(o, o.total, "manual")),
        ]);
        expect(manuals.filter((m) => m.status === 201)).toHaveLength(won === "cancelled" ? 1 : 0);
        for (const m of manuals.filter((x) => x.status === 201)) {
          expect((await execute(m.data.refund.id, "CK-T169-005")).data.outcome).toBe("succeeded");
        }
        expect(await moneyOf(o.orderId)).toMatchObject({ succeeded: o.total, held: 0 });
      });
    });

    describe("lỗi tạm (timeout, 5xx) — giữ nguyên, KHÔNG nhả tiền", () => {
      it("timeout trước khi cổng ghi → `unknown`; cổng tắt sau đó: thực hiện 409 giữ `unknown`, không hủy, không hoàn tay; bật lại → hỏi cùng mã → hoàn đúng một lần", async () => {
        const { o, id } = await approvedProviderRefund();
        mock.faults.push("timeout_before_commit");
        expect((await execute(id)).status).toBe(202);
        disable();
        expect((await execute(id)).data.code).toBe("REFUND_PROVIDER_DISABLED");
        expect(await row(id)).toMatchObject({ state: "unknown", attempts: 1 });
        expect((await cancel(id)).data.code).toBe("INVALID_STATE");
        expect((await createRefund(other(o, o.total, "manual"))).data.code).toBe("REFUND_EXCEEDS_CAPTURED");
        enable();
        expect((await execute(id)).data.outcome).toBe("succeeded");
        expect(mock.totalRefunded()).toBe(o.total);
      });

      it("cổng ĐÃ hoàn nhưng trả timeout → `unknown`; cổng tắt: giữ `unknown`; bật lại → hỏi thấy đã hoàn → succeeded, KHÔNG gửi lần hai", async () => {
        const { o, id } = await approvedProviderRefund();
        mock.faults.push("timeout_after_commit");
        expect((await execute(id)).status).toBe(202);
        expect(mock.totalRefunded()).toBe(o.total);
        disable();
        expect((await execute(id)).status).toBe(409);
        expect((await row(id)).state).toBe("unknown");
        expect((await cancel(id)).status).toBe(409);
        expect((await createRefund(other(o, o.total, "manual"))).status).toBe(422);
        enable();
        expect((await execute(id)).data.outcome).toBe("succeeded");
        expect(mock.calls).toBe(1);
        expect(mock.totalRefunded()).toBe(o.total);
        expect(await moneyOf(o.orderId)).toMatchObject({ succeeded: o.total, held: 0 });
      });

      it("cổng trả 5xx/đứt mạng → `unknown` + ngoại lệ refund_unknown; vẫn giữ số tiền, không hủy được", async () => {
        const { o, id } = await approvedProviderRefund();
        const flaky = new ThrowingRefundGateway();
        setRefundGatewayForTest(flaky);
        const exec = await execute(id);
        expect({ status: exec.status, outcome: exec.data.outcome }).toEqual({
          status: 202,
          outcome: "unknown",
        });
        expect(await row(id)).toMatchObject({ state: "unknown", attempts: 1 });
        expect((await cancel(id)).status).toBe(409);
        expect(await moneyOf(o.orderId)).toMatchObject({ held: o.total, succeeded: 0 });
        expect(
          (await checkout().listOpsExceptions({ order_id: o.orderId, kind: "refund_unknown" })).length,
        ).toBe(1);
      });

      it("`failed` ĐÃ gửi cổng (attempts > 0) rồi cổng tắt → không hủy mù (409), giữ `failed`, không tăng lượt", async () => {
        const { o, id } = await approvedProviderRefund();
        mock.faults.push("fail");
        expect((await execute(id)).status).toBe(502);
        expect(await row(id)).toMatchObject({ state: "failed", attempts: 1 });
        disable();
        expect((await cancel(id)).data.code).toBe("REFUND_PROVIDER_DISABLED");
        expect((await execute(id)).data.code).toBe("REFUND_PROVIDER_DISABLED");
        expect(await row(id)).toMatchObject({ state: "failed", attempts: 1, last_error: "response_94" });
        expect(await moneyOf(o.orderId)).toMatchObject({ held: o.total });
      });
    });

    describe("R2/AT36 — attempt `captured` + giao dịch thành công thứ hai khác mã", () => {
      it("đơn đã hủy: mở payment_unknown attempt_txn_conflict (attempt_state captured) + late_payment; khoản thu thứ hai hoàn `manual` (auto chọn manual, provider 422)", async () => {
        const o = await flow.place([["Trắng/M", 1]], "vnpay");
        const [pa0] = await checkout().listPaymentAttempts({ order_id: o.orderId });
        const t1 = pa0!.provider_txn_no!;
        expect((await flow.cancel(o)).data.cancel).toEqual({ outcome: "cancelled", refund_requested: true });
        const second = gateway.mock.pay(o.paymentUrl, "success");
        const t2 = second.get("vnp_TransactionNo")!;
        expect(t2).not.toBe(t1);
        expect((await ipn(api, second)).data.RspCode).toBe("00");

        expect((await checkout().listPaymentAttempts({ order_id: o.orderId }))[0]).toMatchObject({
          state: "captured",
          provider_txn_no: t1,
        });
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["open"]);
        const conflict = await exceptions(o.orderId, "payment_unknown");
        expect(conflict.map((e) => [e.state, e.priority, e.amount])).toEqual([["open", "high", o.total]]);
        expect(conflict[0]!.detail).toMatchObject({
          reason: "attempt_txn_conflict",
          provider_txn_id: t2,
          attempt_provider_txn_no: t1,
          attempt_state: "captured",
          order_state: "cancelled",
        });
        // IPN gửi lại → không mở thêm.
        expect((await ipn(api, second)).data.RspCode).toBe("02");
        expect(await exceptions(o.orderId, "payment_unknown")).toHaveLength(1);

        const late = {
          order_id: o.orderId,
          reason: "late_payment",
          amount: o.total,
          note: "Tiền đến sau khi hủy",
        };
        const viaProvider = await createRefund({ ...late, method: "provider" });
        expect({ status: viaProvider.status, code: viaProvider.data.code }).toEqual({
          status: 422,
          code: "REFUND_METHOD_UNAVAILABLE",
        });
        const auto = await createRefund({ ...late, method: "auto" });
        expect(auto.status).toBe(201);
        expect(auto.data.refund).toMatchObject({ method: "manual", provider: "manual" });
        expect(auto.data.refund.note).toContain("attempt_txn_conflict");

        // Hoàn hủy đơn (khoản thu đầu, qua cổng) + hoàn tay khoản thu thứ hai → ròng 0 → late_payment đóng.
        const [cancelRefund] = (await returns().listRefundsOfOrder(o.orderId)).filter(
          (r) => r.reason === "cancellation",
        );
        expect(cancelRefund).toMatchObject({ method: "provider", capture_ref: t1 });
        expect(
          (await flow.admin(`/admin/x/refunds/${cancelRefund!.id}/approve`, A("accountant"))).status,
        ).toBe(200);
        expect((await execute(cancelRefund!.id)).data.outcome).toBe("succeeded");
        expect((await execute(auto.data.refund.id, "CK-T169-006")).data.outcome).toBe("succeeded");
        expect((await exceptions(o.orderId, "late_payment")).map((e) => e.state)).toEqual(["resolved"]);
        expect(await moneyOf(o.orderId)).toEqual({
          captured: 2 * o.total,
          succeeded: 2 * o.total,
          held: 0,
          rows: 2,
        });
      });

      it("AT36 đơn đã xác nhận: overpayment + payment_unknown attempt_txn_conflict (order_state confirmed); hoàn `auto` → manual", async () => {
        const o = await flow.place([["Đen/S", 1]], "vnpay");
        const second = gateway.mock.pay(o.paymentUrl, "success");
        expect((await ipn(api, second)).data.RspCode).toBe("00");
        expect((await exceptions(o.orderId, "overpayment")).map((e) => e.amount)).toEqual([o.total]);
        const conflict = await exceptions(o.orderId, "payment_unknown");
        expect(conflict).toHaveLength(1);
        expect(conflict[0]!.detail).toMatchObject({
          reason: "attempt_txn_conflict",
          provider_txn_id: second.get("vnp_TransactionNo"),
          attempt_state: "captured",
          order_state: "confirmed",
        });
        const auto = await createRefund({
          order_id: o.orderId,
          reason: "overpayment",
          amount: o.total,
          method: "auto",
          note: "Khách trả hai lần",
        });
        expect(auto.status).toBe(201);
        expect(auto.data.refund).toMatchObject({ method: "manual" });
        expect(auto.data.refund.note).toContain("attempt_txn_conflict");
      });

      it("đối chứng: một giao dịch duy nhất (gắn attempt) → không mở payment_unknown; `auto` chọn provider", async () => {
        const o = await flow.place([["Đen/S", 1]], "vnpay");
        expect(await exceptions(o.orderId, "payment_unknown")).toHaveLength(0);
        expect((await createRefund(other(o, 100_000, "auto"))).data.refund.method).toBe("provider");
      });
    });
  },
});
