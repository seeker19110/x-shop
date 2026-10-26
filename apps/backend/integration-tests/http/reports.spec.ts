import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-028 — báo cáo tiền tách theo định nghĩa + dashboard ngoại lệ (§5.5, S-406, AT14): giá trị đơn ≠ đã thu theo hệ
 * thống ≠ thực nhận theo chứng từ ≠ đã hoàn; COD đã giao chưa đối soát là "phải nhận"; ngoại lệ có owner/ưu tiên/tuổi.
 */
const HEADER = "reference,amount,occurred_at,type";
const csvOf = (...lines: string[]) => [HEADER, ...lines].join("\n") + "\n";
const line = (ref: string, amount: number, type: string) =>
  `${ref},${amount},${new Date().toISOString()},${type}`;

type Res = { status: number; data: J; headers: Record<string, string> };
type Role = "order_staff" | "support" | "warehouse" | "accountant" | "catalog_manager";

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
    const A = (role: Role) => staff[role].headers;
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const get = (path: string, role: Role = "accountant"): Promise<Res> =>
      api.get(path, { headers: A(role), validateStatus: () => true }) as Promise<Res>;
    const importCsv = (source: string, csv: string): Promise<Res> =>
      api.post(`/admin/x/settlements/batches?source=${source}`, csv, {
        headers: { ...A("accountant"), "content-type": "text/csv" },
        validateStatus: () => true,
      }) as Promise<Res>;
    const txnRefOf = async (orderId: string) =>
      (await checkout().listPaymentAttempts({ order_id: orderId }))[0]!.txn_ref;

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "warehouse", "accountant", "catalog_manager"] as const) {
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
        stock: { "Đen/S": 30, "Đen/M": 30, "Trắng/S": 30, "Trắng/M": 30 },
      });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      clearShippingFeeCache();
      ip = newIp();
    });

    describe("báo cáo tách giá trị đơn / đã thu / thực nhận / đã hoàn (§5.5)", () => {
      it("AT14: COD đã giao chưa chuyển tiền → đã thu theo hệ thống, chưa thực nhận, có số phải thu; đối soát dần → phải thu về 0", async () => {
        const cod = await flow.place([["Đen/M", 1]], "cod");
        const shipment = (await flow.deliver(cod)) as { client_order_code: string };
        const paid = await flow.place([["Trắng/S", 1]], "vnpay");
        const unpaid = await flow.client.placeOrder([["Đen/S", 1]], "vnpay");
        const cancelled = await flow.place([["Trắng/M", 1]], "cod");
        expect((await flow.cancel(cancelled)).status).toBe(200);

        setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
        const refund = await flow.admin(
          "/admin/x/refunds",
          A("accountant"),
          { order_id: paid.orderId, reason: "other", amount: 100_000, note: "Bù phí" },
          { "Idempotency-Key": key() },
        );
        expect(refund.status).toBe(201);
        expect(
          (await flow.admin(`/admin/x/refunds/${refund.data.refund.id}/execute`, A("accountant"))).data
            .outcome,
        ).toBe("succeeded");

        const r = await get("/admin/x/reports/summary");
        expect(r.status).toBe(200);
        expect(r.headers["cache-control"]).toContain("no-store");
        const states = Object.fromEntries((r.data.orders.by_state as J[]).map((s) => [s.state, s]));
        expect(states.confirmed).toEqual({ state: "confirmed", count: 2, value: cod.total + paid.total });
        expect(states.awaiting_payment).toMatchObject({ count: 1, value: unpaid.total });
        expect(states.cancelled).toMatchObject({ count: 1, value: cancelled.total });
        expect(r.data).toMatchObject({
          // Đơn chờ thanh toán online chưa cam kết → tách riêng, không cộng vào giá trị đơn.
          order_value: cod.total + paid.total,
          awaiting_payment_value: unpaid.total,
          collected: { total: paid.total + cod.total, online: paid.total, cod_delivered: cod.total },
          cash_received: { total: 0, cod: 0, vnpay: 0 },
          refunded: { total: 100_000, provider: 100_000, manual: 0, statement_refunds: 0 },
          cod_receivable: { shipments: 1, amount: cod.total },
          discrepancies_open: { count: 0, amount: 0 },
        });

        // Hãng chuyển thiếu 30.000 → thực nhận một phần, còn phải thu 30.000, một chênh lệch mở.
        expect(
          (await importCsv("ghn_cod", csvOf(line(shipment.client_order_code, cod.total - 30_000, "cod"))))
            .status,
        ).toBe(201);
        expect(
          (await importCsv("vnpay", csvOf(line(await txnRefOf(paid.orderId), paid.total, "payment")))).status,
        ).toBe(201);
        const mid = await get("/admin/x/reports/summary");
        expect(mid.data).toMatchObject({
          cash_received: {
            total: cod.total - 30_000 + paid.total,
            cod: cod.total - 30_000,
            vnpay: paid.total,
          },
          cod_receivable: { shipments: 1, amount: 30_000 },
          discrepancies_open: { count: 1, amount: 30_000 },
          // Giá trị đơn và đã thu theo hệ thống không đổi vì đối soát.
          order_value: cod.total + paid.total,
          collected: { total: paid.total + cod.total },
        });

        expect(
          (await importCsv("ghn_cod", csvOf(line(shipment.client_order_code, 30_000, "cod")))).status,
        ).toBe(201);
        const done = await get("/admin/x/reports/summary");
        expect(done.data).toMatchObject({
          cash_received: { cod: cod.total },
          cod_receivable: { shipments: 0, amount: 0 },
          discrepancies_open: { count: 0, amount: 0 },
        });

        // Lọc kỳ: kỳ tương lai → mọi chỉ số theo kỳ bằng 0; phải thu là ảnh chụp hiện tại.
        const from = new Date(Date.now() + 3600_000).toISOString();
        const future = await get(`/admin/x/reports/summary?from=${encodeURIComponent(from)}`);
        expect(future.data).toMatchObject({
          order_value: 0,
          orders: { count: 0 },
          collected: { total: 0 },
          cash_received: { total: 0 },
          refunded: { total: 0 },
          period: { from: new Date(from).toISOString(), to: null },
        });
        for (const q of [
          "from=hom-qua",
          "from=2026-10-25T00:00:00",
          "to=2026-01-01T00:00:00Z&from=2026-02-01T00:00:00Z",
          "x=1",
        ]) {
          const bad = await get(`/admin/x/reports/summary?${q}`);
          expect({ q, status: bad.status, code: bad.data.code }).toEqual({
            q,
            status: 422,
            code: "VALIDATION",
          });
        }
      });
    });

    describe("dashboard ngoại lệ (S-406)", () => {
      it("late_payment + chênh lệch đối soát + COD chưa đối soát: owner/ưu tiên/tuổi, ưu tiên cao trước; lọc; phân trang", async () => {
        const late = await flow.client.placeOrder([["Trắng/S", 1]], "vnpay");
        const fin = (await checkout().listOrderFinances({ order_id: late.orderId }))[0]!;
        await checkout().updateOrderFinances({ id: fin.id, state: "cancelled" });
        expect((await ipn(api, gateway.mock.pay(late.paymentUrl, "success"))).data.RspCode).toBe("00");
        const cod = await flow.place([["Đen/M", 1]], "cod");
        const shipment = (await flow.deliver(cod)) as { id: string; client_order_code: string };
        expect((await importCsv("ghn_cod", csvOf(line("MA-LA-1", 50_000, "cod")))).status).toBe(201);

        const r = await get("/admin/x/reports/exceptions");
        expect(r.status).toBe(200);
        const items = r.data.items as J[];
        const by = (source: string, kind: string) =>
          items.find((i) => i.source === source && i.kind === kind)!;
        expect(by("ops", "late_payment")).toMatchObject({
          order_id: late.orderId,
          amount: late.total,
          owner_role: "accountant",
          state: "open",
          due_at: expect.any(String),
        });
        expect(by("settlement", "unexpected")).toMatchObject({
          reference: "MA-LA-1",
          amount: 50_000,
          priority: "high",
          owner_role: "accountant",
        });
        expect(by("cod", "cod_unsettled")).toMatchObject({
          id: shipment.id,
          order_id: cod.orderId,
          reference: shipment.client_order_code,
          amount: cod.total,
          priority: "normal",
          owner_role: "accountant",
          owner: null,
        });
        for (const i of items) {
          expect(i.age_seconds).toBeGreaterThanOrEqual(0);
          expect(Date.parse(i.opened_at)).not.toBeNaN();
        }
        const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;
        const ranks = items.map((i) => rank[i.priority]!);
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
        expect(r.data.count).toBe(items.length);
        expect(r.data.by_kind).toEqual(
          expect.arrayContaining([
            { source: "cod", kind: "cod_unsettled", count: 1, amount: cod.total },
            { source: "settlement", kind: "unexpected", count: 1, amount: 50_000 },
          ]),
        );

        const onlyCod = await get("/admin/x/reports/exceptions?source=cod");
        expect(onlyCod.data.items.map((i: J) => i.kind)).toEqual(["cod_unsettled"]);
        const onlyLate = await get("/admin/x/reports/exceptions?kind=late_payment");
        expect(onlyLate.data.items.map((i: J) => i.order_id)).toEqual([late.orderId]);
        const high = await get("/admin/x/reports/exceptions?priority=high");
        expect((high.data.items as J[]).every((i) => i.priority === "high")).toBe(true);
        const page = await get("/admin/x/reports/exceptions?limit=1&offset=1");
        expect(page.data).toMatchObject({ limit: 1, offset: 1, count: items.length });
        expect(page.data.items).toEqual([items[1]]);
        for (const q of ["limit=0", "limit=101", "source=khac", "kind=DROP%20TABLE", "priority=max"]) {
          expect({ q, status: (await get(`/admin/x/reports/exceptions?${q}`)).status }).toEqual({
            q,
            status: 422,
          });
        }

        // Đối soát xong → COD không còn trên dashboard.
        expect(
          (await importCsv("ghn_cod", csvOf(line(shipment.client_order_code, cod.total, "cod")))).status,
        ).toBe(201);
        const after = await get("/admin/x/reports/exceptions?source=cod");
        expect(after.data.items).toEqual([]);

        // D-040: kind mới của read model catalog hiện trên dashboard, owner mặc định "owner", lọc theo kind được.
        expect(
          await checkout().openOpsExceptionIfNoneActive({
            kind: "catalog_index_mismatch",
            dedupe_key: "catalog_index_mismatch:test",
            priority: "high",
            detail: { op: "rebuild", missing: 3 },
          }),
        ).toBe(true);
        const mismatch = await get("/admin/x/reports/exceptions?kind=catalog_index_mismatch");
        expect(mismatch.status).toBe(200);
        expect(mismatch.data.items).toEqual([
          expect.objectContaining({
            source: "ops",
            kind: "catalog_index_mismatch",
            priority: "high",
            state: "open",
            owner_role: "owner",
          }),
        ]);
      });
    });

    describe("COD nhận dư", () => {
      it("hãng chuyển DƯ cho vận đơn COD → disputed; không còn phải thu, không hiện cod_unsettled; chênh lệch dư trên dashboard", async () => {
        const cod = await flow.place([["Đen/M", 1]], "cod");
        const shipment = (await flow.deliver(cod)) as { id: string; client_order_code: string };
        const before = await get("/admin/x/reports/summary");
        expect(before.data.cod_receivable).toEqual({ shipments: 1, amount: cod.total });

        const r = await importCsv(
          "ghn_cod",
          csvOf(line(shipment.client_order_code, cod.total + 20_000, "cod")),
        );
        expect(r.status).toBe(201);
        expect(r.data.lines[0]).toMatchObject({ result: "amount_mismatch", difference: 20_000 });

        const after = await get("/admin/x/reports/summary");
        expect(after.data).toMatchObject({
          cod_receivable: { shipments: 0, amount: 0 },
          cash_received: { cod: cod.total + 20_000 },
          discrepancies_open: { count: 1, amount: 20_000 },
        });
        const ex = await get("/admin/x/reports/exceptions");
        const items = ex.data.items as J[];
        expect(items.filter((i) => i.source === "cod")).toEqual([]);
        expect(items.filter((i) => i.source === "settlement")).toEqual([
          expect.objectContaining({ kind: "amount_mismatch", order_id: cod.orderId, amount: 20_000 }),
        ]);
      });
    });

    describe("phân quyền", () => {
      it("kế toán xem cả hai; kho 403; quản lý catalog chỉ báo cáo (report.read); CSKH/nhân viên đơn chỉ dashboard (exception.read)", async () => {
        const matrix: Array<[Role, number, number]> = [
          ["accountant", 200, 200],
          ["warehouse", 403, 403],
          ["catalog_manager", 200, 403],
          ["support", 403, 200],
          ["order_staff", 403, 200],
        ];
        for (const [role, summary, exceptions] of matrix) {
          const s = await get("/admin/x/reports/summary", role);
          const e = await get("/admin/x/reports/exceptions", role);
          expect({ role, summary: s.status, exceptions: e.status }).toEqual({ role, summary, exceptions });
          for (const res of [s, e].filter((x) => x.status === 403)) {
            expect(res.data.code).toBe("FORBIDDEN");
            expect(res.headers["content-type"]).toContain("application/problem+json");
          }
        }
      });
    });
  },
});
