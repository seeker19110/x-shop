import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { RETURNS_CONFIG } from "../../src/modules/returns/constants";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import {
  createAdmin,
  createMfaAdmin,
  type AdminAccount,
  type HttpClient,
  type MfaAdmin,
} from "../helpers/auth";
import { CONTACT, DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { HANOI_ADDRESS, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-049 — hàng đợi hoàn tiền: `GET /admin/x/refunds?state=…` KHÔNG cần `order_id` (mọi đơn, cũ nhất trước, phân trang
 * limit ≤ 100/offset); chỉ trả đúng trạng thái hỏi. Có `order_id` → giữ nguyên bản tổng hợp theo đơn. Quyền
 * `refund.request` (CSKH, kế toán, owner); kho/nhân viên đơn → 403. Không lộ PII khách.
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
    const staff = {} as Record<"order_staff" | "support" | "warehouse" | "accountant" | "owner", MfaAdmin>;
    let noRole: AdminAccount;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const A = (role: keyof typeof staff) => staff[role].headers;
    const get = (path: string, headers: Record<string, string> = A("accountant")) =>
      flow.adminGet(path, headers);
    const createRefund = async (role: keyof typeof staff, o: PlacedOrder, amount: number) => {
      const r = await flow.admin(
        "/admin/x/refunds",
        A(role),
        { order_id: o.orderId, reason: "other", amount, note: "Hoàn bù chênh lệch" },
        { "Idempotency-Key": key() },
      );
      expect(r.status).toBe(201);
      return r.data.refund as J;
    };
    const queue = async (q: string, headers?: Record<string, string>) => {
      const r = await get(`/admin/x/refunds?${q}`, headers);
      expect({ q, status: r.status }).toEqual({ q, status: 200 });
      return r.data;
    };
    const ids = async (q: string) => {
      const d = await queue(q);
      return { ids: d.refunds.map((r: J) => r.id), count: d.count };
    };
    const expectNoPii = (data: unknown) => {
      const text = JSON.stringify(data);
      expect(text.replace(/\D/g, "")).not.toContain(CONTACT.phone.replace(/\D/g, ""));
      for (const s of [CONTACT.email, CONTACT.name, HANOI_ADDRESS.line]) expect(text).not.toContain(s);
    };

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "accountant", "owner"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      noRole = await createAdmin(rawApi as unknown as HttpClient, container, { roles: [] });
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
      refundGateway = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(refundGateway);
      ip = newIp();
    });

    it("hàng đợi theo state trên mọi đơn: đúng trạng thái, cũ nhất trước, phân trang, ca rỗng; failed hết lượt → hủy → cancelled", async () => {
      const empty = await queue("state=requested");
      expect(empty).toEqual({ state: "requested", refunds: [], count: 0, limit: 50, offset: 0 });

      const o1 = await flow.place([["Đen/M", 1]], "vnpay");
      const o2 = await flow.place([["Trắng/S", 1]], "vnpay");
      const r1 = await createRefund("support", o1, 100_000); // CSKH không tự duyệt → requested
      const r2 = await createRefund("accountant", o1, 100_000); // kế toán ≤ ngưỡng → approved
      const r4 = await createRefund("support", o2, 50_000);
      const r3 = await createRefund("accountant", o2, 100_000);
      expect([r1.state, r2.state, r4.state, r3.state]).toEqual([
        "requested",
        "approved",
        "requested",
        "approved",
      ]);

      // Hết lượt thử: mỗi lần cổng từ chối → failed; lần thứ refundMaxAttempts + 1 → 409 REFUND_RETRY_EXHAUSTED.
      for (let i = 0; i < RETURNS_CONFIG.refundMaxAttempts; i++) {
        refundGateway.faults.push("fail");
        const ex = await flow.admin(`/admin/x/refunds/${r3.id}/execute`, A("accountant"));
        expect(ex.status).toBe(502);
      }
      const exhausted = await flow.admin(`/admin/x/refunds/${r3.id}/execute`, A("accountant"));
      expect(exhausted.data.code).toBe("REFUND_RETRY_EXHAUSTED");

      expect(await ids("state=requested")).toEqual({ ids: [r1.id, r4.id], count: 2 });
      expect(await ids("state=approved")).toEqual({ ids: [r2.id], count: 1 });
      const failed = await queue("state=failed");
      expect(failed.refunds).toHaveLength(1);
      expect(failed.refunds[0]).toMatchObject({
        id: r3.id,
        state: "failed",
        attempts: RETURNS_CONFIG.refundMaxAttempts,
        order_id: o2.orderId,
        order_display_ref: o2.ref,
      });
      expect(await ids("state=processing")).toEqual({ ids: [], count: 0 });

      const page = await queue("state=requested");
      expect(page).toMatchObject({ state: "requested", count: 2, limit: 50, offset: 0 });
      expect(page.refunds.map((r: J) => r.state)).toEqual(["requested", "requested"]);
      expect(page.refunds[0]).toMatchObject({
        id: r1.id,
        order_id: o1.orderId,
        order_display_ref: o1.ref,
        amount: 100_000,
        reason: "other",
        requested_by: staff.support.userId,
      });
      expect(page.refunds.map((r: J) => r.order_display_ref)).toEqual([o1.ref, o2.ref]);
      expectNoPii(page);
      // Phân trang: count = tổng khớp lọc.
      expect(await ids("state=requested&limit=1")).toEqual({ ids: [r1.id], count: 2 });
      expect(await ids("state=requested&limit=1&offset=1")).toEqual({ ids: [r4.id], count: 2 });
      expect(await ids("state=requested&limit=100&offset=2")).toEqual({ ids: [], count: 2 });

      // Hủy refund failed (lý do bắt buộc) → rời hàng đợi failed, vào cancelled.
      expect((await flow.admin(`/admin/x/refunds/${r3.id}/cancel`, A("accountant"), {})).status).toBe(422);
      const cancel = await flow.admin(`/admin/x/refunds/${r3.id}/cancel`, A("accountant"), {
        reason: "Đổi sang hoàn ngoài hệ thống",
      });
      expect(cancel.status).toBe(200);
      expect(await ids("state=failed")).toEqual({ ids: [], count: 0 });
      const cancelled = await queue("state=cancelled");
      expect(cancelled.refunds).toHaveLength(1);
      expect(cancelled.refunds[0]).toMatchObject({
        id: r3.id,
        state: "cancelled",
        cancel_reason: "Đổi sang hoàn ngoài hệ thống",
        cancelled_by: staff.accountant.userId,
      });

      // Có order_id → giữ nguyên bản tổng hợp theo đơn (không phân trang, mọi trạng thái của đơn).
      const summary = await get(`/admin/x/refunds?order_id=${o1.orderId}`);
      expect(summary.status).toBe(200);
      expect(Object.keys(summary.data).sort()).toEqual(
        ["captured", "held", "order_id", "refundable", "refunded", "refunds"].sort(),
      );
      expect(summary.data.refunds.map((r: J) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    });

    it("tham số sai → 422 problem+json nhất quán; order_id kèm tham số hàng đợi → 422; order_id rỗng → 422 như cũ", async () => {
      for (const q of [
        "",
        "limit=10",
        "state=bogus",
        "state=requested&limit=101",
        "state=requested&limit=0",
        "state=requested&limit=abc",
        "state=requested&offset=-1",
        "state=requested&foo=1",
        "state=requested&state=failed",
        "order_id=",
        "order_id=order_x&state=requested",
        "order_id=order_x&limit=10",
      ]) {
        const r = await get(`/admin/x/refunds${q ? `?${q}` : ""}`);
        expect({ q, status: r.status, code: r.data.code }).toEqual({ q, status: 422, code: "VALIDATION" });
        expect(r.headers["content-type"]).toContain("application/problem+json");
      }
      expect((await get("/admin/x/refunds?state=requested&limit=100")).status).toBe(200);
      // Đơn không tồn tại (chế độ theo đơn) → 404 như trước.
      expect((await get("/admin/x/refunds?order_id=order_khong_co")).status).toBe(404);
    });

    it("phân quyền: CSKH/kế toán/owner đọc được hàng đợi; kho, nhân viên đơn, không vai trò → 403; chưa đăng nhập → 401", async () => {
      const o = await flow.place([["Đen/M", 1]], "vnpay");
      const r = await createRefund("support", o, 100_000);
      for (const role of ["support", "accountant", "owner"] as const) {
        const d = await queue("state=requested", A(role));
        expect({ role, ids: d.refunds.map((x: J) => x.id) }).toEqual({ role, ids: [r.id] });
      }
      for (const role of ["warehouse", "order_staff"] as const) {
        const res = await get("/admin/x/refunds?state=requested", A(role));
        expect({ role, status: res.status, code: res.data.code }).toEqual({
          role,
          status: 403,
          code: "FORBIDDEN",
        });
      }
      expect((await get("/admin/x/refunds?state=requested", noRole.headers)).status).toBe(403);
      expect((await get("/admin/x/refunds?state=requested", {})).status).toBe(401);
    });

    it("đọc hàng đợi song song trong lúc duyệt → mọi lần đọc 200 và chỉ chứa đúng trạng thái; sau đó yêu cầu chuyển hàng đợi", async () => {
      const o = await flow.place([["Đen/M", 1]], "vnpay");
      const r = await createRefund("support", o, 100_000);
      const [approved, ...reads] = await Promise.all([
        flow.admin(`/admin/x/refunds/${r.id}/approve`, A("accountant")),
        ...Array.from({ length: 6 }, (_, i) =>
          get(`/admin/x/refunds?state=${i % 2 ? "approved" : "requested"}`),
        ),
      ]);
      expect(approved!.status).toBe(200);
      for (const res of reads) {
        expect(res.status).toBe(200);
        for (const x of res.data.refunds as J[]) expect(x.state).toBe(res.data.state);
        expect(res.data.count).toBe(res.data.refunds.length);
      }
      expect(await ids("state=requested")).toEqual({ ids: [], count: 0 });
      expect(await ids("state=approved")).toEqual({ ids: [r.id], count: 1 });
    });
  },
});
