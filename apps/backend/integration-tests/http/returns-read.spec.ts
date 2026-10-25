import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import {
  createAdmin,
  createMfaAdmin,
  type AdminAccount,
  type HttpClient,
  type MfaAdmin,
} from "../helpers/auth";
import { CONTACT, DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import { HANOI_ADDRESS, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-049 — đọc yêu cầu đổi/trả cho Admin: `GET /admin/x/returns` (lọc state/order_id/source, phân trang, mới nhất trước)
 * và `GET /admin/x/returns/:id` (dòng hàng + kết quả kiểm định). Hàng hoàn từ hãng (T-045) có trong danh sách, đánh dấu
 * `source: "carrier"`. Quyền `return.receive` (kho, owner) — CSKH/kế toán/nhân viên đơn bị từ chối. Không lộ PII khách.
 * Dữ liệu tạo qua luồng HTTP thật (submit → COD/IPN → vận đơn GHN mock → callback).
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
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
    const get = (path: string, headers: Record<string, string> = A("warehouse")) =>
      flow.adminGet(path, headers);

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
      clearShippingFeeCache();
      setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
      ip = newIp();
    });

    const lineOf = async (orderId: string, variantKey: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "items.id", "items.variant_id"],
        filters: { id: orderId },
      });
      const items = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items;
      return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
    };

    /** Khách tạo yêu cầu trả; trả id. */
    async function requested(o: PlacedOrder, lines: Array<[string, number]>, note?: string): Promise<string> {
      const body = {
        kind: "return",
        reason: "changed_mind",
        ...(note && { note }),
        lines: await Promise.all(
          lines.map(async ([k, quantity]) => ({ line_id: await lineOf(o.orderId, k), quantity })),
        ),
      };
      const r = await flow.requestReturn(o, body);
      expect(r.status).toBe(201);
      return r.data.return.id as string;
    }

    /** Hãng hủy vận đơn trước lấy hàng → hệ thống mở yêu cầu hàng hoàn (khóa `carrier:`), đã nhận vào cách ly. */
    async function carrierReturn(): Promise<{ order: PlacedOrder; id: string }> {
      const o = await flow.place([["Đen/S", 1]], "cod");
      const created = (await api.post(
        `/admin/x/orders/${o.orderId}/shipments`,
        {},
        { headers: A("order_staff"), validateStatus: () => true },
      )) as Res<J>;
      expect(created.status).toBe(201);
      const code = created.data.shipment.provider_order_code as string;
      ghn.setStatusByOrderCode(code, "cancel");
      const cb = (await api.post(
        "/x/webhooks/shipping/ghn",
        {
          OrderCode: code,
          Type: "Switch_status",
          Status: "cancel",
          Time: new Date().toISOString(),
          CODAmount: 0,
        },
        { validateStatus: () => true },
      )) as Res<J>;
      expect(cb.data.carrier).toMatchObject({ outcome: "cancelled", return_state: "received" });
      const list = await get(`/admin/x/returns?order_id=${o.orderId}`);
      expect(list.data.count).toBe(1);
      return { order: o, id: list.data.returns[0].id as string };
    }

    /** Không chuỗi PII nào của khách (SĐT, email, tên, địa chỉ) xuất hiện trong phản hồi. */
    const expectNoPii = (data: unknown) => {
      const text = JSON.stringify(data);
      const digits = text.replace(/\D/g, "");
      expect(digits).not.toContain(CONTACT.phone.replace(/\D/g, ""));
      for (const s of [CONTACT.email, CONTACT.name, HANOI_ADDRESS.line]) expect(text).not.toContain(s);
    };

    describe("danh sách + lọc + phân trang", () => {
      it("mới nhất trước; lọc state/order_id/source; phân trang ổn định; ca rỗng; hàng hoàn từ hãng được đánh dấu", async () => {
        // Rỗng: chưa có yêu cầu nào.
        const empty = await get("/admin/x/returns");
        expect(empty.status).toBe(200);
        expect(empty.headers["cache-control"]).toBe("no-store");
        expect(empty.data).toEqual({ returns: [], count: 0, limit: 50, offset: 0 });

        const o1 = await flow.deliveredOrder(
          [
            ["Đen/M", 1],
            ["Trắng/S", 2],
          ],
          "cod",
        );
        const r1 = await requested(o1, [["Trắng/S", 2]], "Không hợp màu");
        const o2 = await flow.deliveredOrder([["Trắng/M", 2]], "cod");
        const r2 = await requested(o2, [["Trắng/M", 2]]);
        expect((await flow.admin(`/admin/x/returns/${r2}/approve`, A("support"))).status).toBe(200);
        // Nhận từng phần: 1/2.
        const recv = await flow.admin(`/admin/x/returns/${r2}/receive`, A("warehouse"), {
          lines: [{ line_id: await lineOf(o2.orderId, "Trắng/M"), quantity: 1 }],
        });
        expect(recv.status).toBe(200);
        const c = await carrierReturn();

        const all = await get("/admin/x/returns");
        expect(all.status).toBe(200);
        expect(all.data.count).toBe(3);
        expect(all.data.returns.map((r: J) => r.id)).toEqual([c.id, r2, r1]);
        expect(all.data.returns.map((r: J) => r.source)).toEqual(["carrier", "request", "request"]);
        expect(all.data.returns[1]).toMatchObject({
          id: r2,
          kind: "return",
          state: "received",
          source: "request",
          channel: "customer",
          order_id: o2.orderId,
          order_display_ref: o2.ref,
          line_count: 1,
          quantity: 2,
          received_quantity: 1,
          refund: null,
        });
        expect(all.data.returns[2]).toMatchObject({ id: r1, state: "requested", received_quantity: null });
        expect(all.data.returns[0]).toMatchObject({ state: "received", source: "carrier", channel: "staff" });
        expectNoPii(all.data);

        const ids = async (q: string) => {
          const r = await get(`/admin/x/returns?${q}`);
          expect({ q, status: r.status }).toEqual({ q, status: 200 });
          return { ids: r.data.returns.map((x: J) => x.id), count: r.data.count };
        };
        expect(await ids("state=requested")).toEqual({ ids: [r1], count: 1 });
        expect(await ids("state=received")).toEqual({ ids: [c.id, r2], count: 2 });
        expect(await ids("state=closed")).toEqual({ ids: [], count: 0 });
        expect(await ids(`order_id=${o1.orderId}`)).toEqual({ ids: [r1], count: 1 });
        expect(await ids("order_id=order_khong_co")).toEqual({ ids: [], count: 0 });
        expect(await ids("source=carrier")).toEqual({ ids: [c.id], count: 1 });
        expect(await ids("source=request")).toEqual({ ids: [r2, r1], count: 2 });
        expect(await ids("source=request&state=received")).toEqual({ ids: [r2], count: 1 });
        // Phân trang: count là tổng khớp lọc, không phải độ dài trang.
        expect(await ids("limit=1")).toEqual({ ids: [c.id], count: 3 });
        expect(await ids("limit=1&offset=1")).toEqual({ ids: [r2], count: 3 });
        expect(await ids("limit=2&offset=2")).toEqual({ ids: [r1], count: 3 });
        expect(await ids("limit=100&offset=3")).toEqual({ ids: [], count: 3 });
        const page = await get("/admin/x/returns?limit=2&offset=1");
        expect(page.data).toMatchObject({ limit: 2, offset: 1 });
      });

      it("tham số sai → 422 problem+json nhất quán (limit vượt/0/âm, offset âm, state/source lạ, tham số lạ, lặp tham số)", async () => {
        for (const q of [
          "limit=101",
          "limit=0",
          "limit=-1",
          "limit=abc",
          "limit=1.5",
          "offset=-1",
          "state=bogus",
          "source=system",
          "foo=1",
          "state=requested&state=approved",
          `order_id=${"x".repeat(129)}`,
        ]) {
          const r = await get(`/admin/x/returns?${q}`);
          expect({ q, status: r.status, code: r.data.code }).toEqual({ q, status: 422, code: "VALIDATION" });
          expect(r.headers["content-type"]).toContain("application/problem+json");
        }
        // Biên hợp lệ.
        expect((await get("/admin/x/returns?limit=100")).status).toBe(200);
        expect((await get("/admin/x/returns?limit=1&offset=0")).status).toBe(200);
      });
    });

    describe("chi tiết", () => {
      it("dòng hàng có tên sản phẩm, số đã nhận từng phần, kết quả kiểm định + ghi chú, hoàn tiền; id không có → 404", async () => {
        const o = await flow.deliveredOrder(
          [
            ["Đen/M", 1],
            ["Trắng/S", 2],
          ],
          "vnpay",
        );
        const black = await lineOf(o.orderId, "Đen/M");
        const white = await lineOf(o.orderId, "Trắng/S");
        const id = await requested(o, [
          ["Đen/M", 1],
          ["Trắng/S", 2],
        ]);

        const d0 = await get(`/admin/x/returns/${id}`);
        expect(d0.status).toBe(200);
        expect(d0.headers["cache-control"]).toBe("no-store");
        expect(d0.data.return).toMatchObject({
          id,
          state: "requested",
          source: "request",
          order_id: o.orderId,
          order_display_ref: o.ref,
          received_at: null,
          inspected_at: null,
          refund: null,
        });
        const l0 = new Map(d0.data.return.lines.map((l: J) => [l.line_id, l]));
        expect(l0.get(white)).toMatchObject({
          quantity: 2,
          received_quantity: null,
          restock_quantity: null,
          inspection_note: null,
        });
        expect(typeof (l0.get(white) as J).title).toBe("string");
        expect((l0.get(white) as J).title.length).toBeGreaterThan(0);

        expect((await flow.admin(`/admin/x/returns/${id}/approve`, A("support"))).status).toBe(200);
        // Nhận từng phần: đen 1/1, trắng 1/2.
        const recv = await flow.admin(`/admin/x/returns/${id}/receive`, A("warehouse"), {
          lines: [
            { line_id: black, quantity: 1 },
            { line_id: white, quantity: 1 },
          ],
        });
        expect(recv.status).toBe(200);
        const d1 = await get(`/admin/x/returns/${id}`);
        expect(d1.data.return.state).toBe("received");
        expect(d1.data.return.received_at).toEqual(expect.any(String));
        const l1 = new Map(d1.data.return.lines.map((l: J) => [l.line_id, l]));
        expect((l1.get(black) as J).received_quantity).toBe(1);
        expect((l1.get(white) as J).received_quantity).toBe(1);

        const insp = await flow.admin(`/admin/x/returns/${id}/inspect`, A("warehouse"), {
          lines: [
            { line_id: black, restock_quantity: 1, damaged_quantity: 0 },
            { line_id: white, restock_quantity: 0, damaged_quantity: 1, note: "Rách đường may" },
          ],
        });
        expect(insp.status).toBe(200);
        const d2 = await get(`/admin/x/returns/${id}`);
        expect(d2.data.return.state).toBe("inspected");
        expect(d2.data.return.inspected_at).toEqual(expect.any(String));
        const l2 = new Map(d2.data.return.lines.map((l: J) => [l.line_id, l]));
        expect(l2.get(black)).toMatchObject({
          restock_quantity: 1,
          damaged_quantity: 0,
          rejected_quantity: 0,
          inspection_note: null,
        });
        expect(l2.get(white)).toMatchObject({
          restock_quantity: 0,
          damaged_quantity: 1,
          rejected_quantity: 0,
          inspection_note: "Rách đường may",
        });
        expect(Number.isSafeInteger((l2.get(black) as J).refund_amount)).toBe(true);
        expect(d2.data.return.refund).toMatchObject({ id: expect.any(String), state: expect.any(String) });
        expect(d2.data.return.refund.amount).toBe(
          (l2.get(black) as J).refund_amount + (l2.get(white) as J).refund_amount,
        );
        expectNoPii(d2.data);
        // Danh sách phản ánh cùng hoàn tiền.
        const list = await get(`/admin/x/returns?order_id=${o.orderId}`);
        expect(list.data.returns[0].refund).toEqual({
          id: d2.data.return.refund.id,
          amount: d2.data.return.refund.amount,
          state: d2.data.return.refund.state,
        });

        for (const missing of ["xret_khong_co", "%20", "a".repeat(200)]) {
          const r = await get(`/admin/x/returns/${missing}`);
          expect({ missing: missing.slice(0, 20), status: r.status, code: r.data.code }).toEqual({
            missing: missing.slice(0, 20),
            status: 404,
            code: "NOT_FOUND",
          });
          expect(r.headers["content-type"]).toContain("application/problem+json");
        }
      });

      it("hàng hoàn từ hãng: chi tiết đánh dấu source=carrier, không lộ PII", async () => {
        const c = await carrierReturn();
        const d = await get(`/admin/x/returns/${c.id}`);
        expect(d.status).toBe(200);
        expect(d.data.return).toMatchObject({
          id: c.id,
          source: "carrier",
          state: "received",
          requested_by: "system:carrier",
          order_display_ref: c.order.ref,
        });
        expectNoPii(d.data);
      });
    });

    describe("phân quyền + đồng thời", () => {
      it("kho/owner đọc được; CSKH, kế toán, nhân viên đơn, user không vai trò → 403; chưa đăng nhập → 401", async () => {
        const o = await flow.deliveredOrder([["Đen/M", 1]], "cod");
        const id = await requested(o, [["Đen/M", 1]]);
        for (const path of ["/admin/x/returns", `/admin/x/returns/${id}`]) {
          for (const role of ["warehouse", "owner"] as const) {
            const r = await get(path, A(role));
            expect({ path, role, status: r.status }).toEqual({ path, role, status: 200 });
          }
          for (const role of ["support", "accountant", "order_staff"] as const) {
            const r = await get(path, A(role));
            expect({ path, role, status: r.status, code: r.data.code }).toEqual({
              path,
              role,
              status: 403,
              code: "FORBIDDEN",
            });
          }
          expect((await get(path, noRole.headers)).status).toBe(403);
          expect((await get(path, {})).status).toBe(401);
        }
      });

      it("đọc song song trong lúc nhận hàng → mọi lần đọc 200, thấy trạng thái trước hoặc sau (không nửa vời)", async () => {
        const o = await flow.deliveredOrder([["Trắng/S", 2]], "cod");
        const line = await lineOf(o.orderId, "Trắng/S");
        const id = await requested(o, [["Trắng/S", 2]]);
        expect((await flow.admin(`/admin/x/returns/${id}/approve`, A("support"))).status).toBe(200);
        const [recv, ...reads] = await Promise.all([
          flow.admin(`/admin/x/returns/${id}/receive`, A("warehouse"), {
            lines: [{ line_id: line, quantity: 2 }],
          }),
          ...Array.from({ length: 4 }, () => get(`/admin/x/returns/${id}`)),
          ...Array.from({ length: 4 }, () => get(`/admin/x/returns?order_id=${o.orderId}`)),
        ]);
        expect(recv!.status).toBe(200);
        for (const r of reads) {
          expect(r.status).toBe(200);
          const ret = (r.data.return ?? r.data.returns[0]) as J;
          if (ret.state === "approved") {
            expect(ret.received_quantity ?? ret.lines?.[0]?.received_quantity ?? null).toBeNull();
          } else {
            expect(ret.state).toBe("received");
          }
        }
        const after = await get(`/admin/x/returns/${id}`);
        expect(after.data.return.state).toBe("received");
        expect(after.data.return.lines[0].received_quantity).toBe(2);
      });
    });
  },
});
