import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { SETTLEMENT_MODULE } from "../../src/modules/settlement";
import type SettlementModuleService from "../../src/modules/settlement/service";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, ipn, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-028 — đối soát COD/sao kê (§5.5, AT14, S-304): nhập batch CSV (định dạng nội bộ giả định), đối chiếu với vận đơn/
 * ledger/hoàn tiền, chênh lệch có lịch sử; nhập lại idempotent (kể cả đồng thời); tiền đến sau hủy và thu dư thành
 * ngoại lệ; ca biên file; phân quyền kế toán được, kho 403. Đơn đi luồng thật qua HTTP (không chèn thẳng DB).
 */
const HEADER = "reference,amount,occurred_at,type";
const csvOf = (...lines: string[]) => [HEADER, ...lines].join("\n") + "\n";
const line = (ref: string, amount: number | string, type: string, at: Date = new Date()) =>
  `${ref},${amount},${at.toISOString()},${type}`;

type Res = { status: number; data: J; headers: Record<string, string> };

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
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
    const A = (role: keyof typeof staff) => staff[role].headers;
    const shipping = () => container.resolve<ShippingModuleService>(SHIPPING_MODULE);
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const settlement = () => container.resolve<SettlementModuleService>(SETTLEMENT_MODULE);

    const importCsv = (
      headers: Record<string, string>,
      source: string,
      csv: string | Buffer,
      params: Record<string, string> = {},
      contentType = "text/csv",
    ): Promise<Res> =>
      api.post(`/admin/x/settlements/batches?${new URLSearchParams({ source, ...params }).toString()}`, csv, {
        headers: { ...headers, "content-type": contentType },
        validateStatus: () => true,
        maxBodyLength: Infinity,
      }) as Promise<Res>;
    const get = (path: string, headers: Record<string, string> = A("accountant")): Promise<Res> =>
      api.get(path, { headers, validateStatus: () => true }) as Promise<Res>;
    const settlementState = async (shipmentId: string) =>
      (await shipping().listShipments({ id: shipmentId }))[0]!.settlement_state;
    const txnRefOf = async (orderId: string) =>
      (await checkout().listPaymentAttempts({ order_id: orderId }))[0]!.txn_ref;

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
        stock: { "Đen/S": 30, "Đen/M": 30, "Trắng/S": 30, "Trắng/M": 30 },
      });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      ip = newIp();
    });

    async function deliveredCod(items: Array<[string, number]> = [["Đen/M", 1]]) {
      const o = await flow.place(items, "cod");
      const s = (await flow.deliver(o)) as {
        id: string;
        client_order_code: string;
        provider_order_code: string;
      };
      return { o, s };
    }

    describe("AT14 + khớp + nhập lại idempotent", () => {
      it("COD giao xong → unsettled; batch khớp → settled; nhập lại cùng chứng từ (CRLF/BOM/đổi thứ tự) → cùng batch, không ghi thêm", async () => {
        const { o, s } = await deliveredCod();
        expect(await settlementState(s.id)).toBe("unsettled");

        const at = new Date();
        const csv = csvOf(line(s.client_order_code, o.total, "cod", at));
        const r1 = await importCsv(A("accountant"), "ghn_cod", csv);
        expect(r1.status).toBe(201);
        expect(r1.data.replayed).toBe(false);
        expect(r1.data.batch).toMatchObject({
          source: "ghn_cod",
          row_count: 1,
          total_amount: o.total,
          imported_by: staff.accountant.userId,
          summary: { results: { matched: 1, amount_mismatch: 0, unexpected: 0 }, shipments_updated: 1 },
        });
        expect(r1.data.lines).toEqual([
          expect.objectContaining({
            reference: s.client_order_code,
            amount: o.total,
            result: "matched",
            target_kind: "shipment",
            target_id: s.id,
            order_id: o.orderId,
          }),
        ]);
        expect(r1.data.discrepancies).toEqual([]);
        expect(await settlementState(s.id)).toBe("settled");

        const variants = [
          csv,
          "﻿" +
            [
              "TYPE,Reference,Amount,Occurred_At",
              `cod,${s.client_order_code},${o.total},${at.toISOString()}`,
            ].join("\r\n"),
        ];
        for (const v of variants) {
          const again = await importCsv(A("accountant"), "ghn_cod", v);
          expect(again.status).toBe(200);
          expect(again.headers["idempotent-replayed"]).toBe("true");
          expect(again.data).toMatchObject({ replayed: true, batch: { id: r1.data.batch.id } });
        }
        // Cùng chứng từ tra theo mã vận đơn của hãng thay vì mã đơn gửi hãng → nội dung khác → batch mới, thu dư.
        const viaProviderCode = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(s.provider_order_code, o.total, "cod", at)),
        );
        expect(viaProviderCode.status).toBe(201);
        expect(viaProviderCode.data.lines[0]).toMatchObject({ result: "overpaid", target_id: s.id });

        const { count } = await settlement().listBatches({}, { limit: 10, offset: 0 });
        expect(count).toBe(2);
        const detail = await get(`/admin/x/settlements/batches/${r1.data.batch.id}`);
        expect(detail.status).toBe(200);
        expect(detail.data.lines).toHaveLength(1);

        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { action: "settlement.batch.imported" },
          { limit: 10, offset: 0 },
        );
        expect(entries).toHaveLength(2);
        expect(entries.at(-1)).toMatchObject({
          actor_id: staff.accountant.userId,
          resource_type: "settlement_batch",
          resource_id: r1.data.batch.id,
          changes: { source: "ghn_cod", row_count: 1, total_amount: o.total },
        });
      });
    });

    describe("đối chiếu khớp / thiếu / thừa / lệch + lịch sử chênh lệch", () => {
      it("batch 1: khớp A, lệch B −50.000, thừa mã lạ, thiếu C (period_end); batch 2 bù → tự đóng có lịch sử; đóng tay có lý do", async () => {
        const a = await deliveredCod();
        const b = await deliveredCod([["Trắng/S", 1]]);
        const c = await deliveredCod([["Đen/S", 1]]);
        const periodEnd = new Date(Date.now() + 1000).toISOString();
        const r1 = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(
            line(a.s.client_order_code, a.o.total, "cod"),
            line(b.s.client_order_code, b.o.total - 50_000, "cod"),
            line("KHONG-CO-DON-1", 100_000, "cod"),
          ),
          { period_end: periodEnd, external_ref: "GHN-COD-2026-10-25" },
        );
        expect(r1.status).toBe(201);
        expect(r1.data.batch).toMatchObject({
          external_ref: "GHN-COD-2026-10-25",
          summary: {
            results: { matched: 1, amount_mismatch: 1, unexpected: 1 },
            missing_opened: 1,
            discrepancies_opened: 3,
          },
        });
        const byKind = Object.fromEntries((r1.data.discrepancies as J[]).map((d) => [d.kind, d]));
        expect(byKind.amount_mismatch).toMatchObject({
          state: "open",
          reference: b.s.client_order_code,
          order_id: b.o.orderId,
          expected_amount: b.o.total,
          actual_amount: b.o.total - 50_000,
          difference: -50_000,
          amount: 50_000,
          priority: "normal",
          owner_role: "accountant",
        });
        expect(byKind.unexpected).toMatchObject({
          reference: "KHONG-CO-DON-1",
          target_id: null,
          amount: 100_000,
          priority: "high",
        });
        expect(byKind.missing).toMatchObject({
          reference: c.s.client_order_code,
          target_id: c.s.id,
          expected_amount: c.o.total,
          actual_amount: 0,
          difference: -c.o.total,
          line_id: null,
        });
        expect(await settlementState(a.s.id)).toBe("settled");
        expect(await settlementState(b.s.id)).toBe("partially_settled");
        expect(await settlementState(c.s.id)).toBe("unsettled");

        // Nhập lại với period_end → "thiếu" không mở lần hai cho cùng vận đơn.
        const r1b = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(a.s.client_order_code, 1, "cod")),
          {
            period_end: periodEnd,
          },
        );
        expect(r1b.data.batch.summary).toMatchObject({ missing_opened: 0, results: { overpaid: 1 } });

        const r2 = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(b.s.client_order_code, 50_000, "cod"), line(c.s.client_order_code, c.o.total, "cod")),
        );
        expect(r2.status).toBe(201);
        expect(r2.data.batch.summary).toMatchObject({ results: { matched: 2 }, auto_resolved: 2 });
        expect(await settlementState(b.s.id)).toBe("settled");
        expect(await settlementState(c.s.id)).toBe("settled");

        const resolved = await get("/admin/x/settlements/discrepancies?state=resolved");
        expect(resolved.status).toBe(200);
        expect(resolved.data.count).toBe(2);
        for (const d of resolved.data.discrepancies as J[]) {
          expect(d.resolved_at).toEqual(expect.any(String));
          expect(d.events.map((e: J) => [e.action, e.actor_type, e.batch_id])).toEqual([
            ["opened", "user", r1.data.batch.id],
            ["auto_resolved", "system", r2.data.batch.id],
          ]);
        }

        const open = await get("/admin/x/settlements/discrepancies?state=open&source=ghn_cod");
        expect(open.data.discrepancies.map((d: J) => d.kind).sort()).toEqual(["overpaid", "unexpected"]);
        const unexpected = (open.data.discrepancies as J[]).find((d) => d.kind === "unexpected")!;

        const path = `/admin/x/settlements/discrepancies/${unexpected.id}/resolve`;
        for (const role of ["warehouse", "support", "order_staff"] as const) {
          const denied = await flow.admin(path, A(role), { note: "Không phải việc của tôi" });
          expect({ role, status: denied.status }).toEqual({ role, status: 403 });
        }
        expect((await flow.admin(path, A("accountant"), { note: "x" })).status).toBe(422);
        const ok = await flow.admin(path, A("accountant"), {
          note: "Hãng chuyển nhầm, đã yêu cầu thu hồi",
          evidence_ref: "GHN-TICKET-889",
        });
        expect(ok.status).toBe(200);
        expect(ok.data.discrepancy).toMatchObject({
          state: "resolved",
          resolved_by: staff.accountant.userId,
          evidence_ref: "GHN-TICKET-889",
        });
        expect(ok.data.discrepancy.events.map((e: J) => [e.action, e.actor_id])).toEqual([
          ["opened", staff.accountant.userId],
          ["resolved", staff.accountant.userId],
        ]);
        const twice = await flow.admin(path, A("accountant"), { note: "Đóng lần hai" });
        expect(twice).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        const missingId = await flow.admin(
          "/admin/x/settlements/discrepancies/khong-co/resolve",
          A("accountant"),
          { note: "Không có" },
        );
        expect(missingId.status).toBe(404);
      });
    });

    describe("ngoại lệ: tiền đến sau hủy, thu dư, thừa; khoản hoàn khớp sao kê", () => {
      it("VNPAY: khớp khoản thu; đơn đã hủy có tiền → late_after_cancel; cùng giao dịch ở sao kê khác → thu dư; attempt chưa thu → thừa; hoàn khớp", async () => {
        const paid = await flow.place([["Đen/M", 1]], "vnpay");
        const late = await flow.client.placeOrder([["Trắng/S", 1]], "vnpay");
        const fin = (await checkout().listOrderFinances({ order_id: late.orderId }))[0]!;
        await checkout().updateOrderFinances({ id: fin.id, state: "cancelled" });
        expect((await ipn(api, gateway.mock.pay(late.paymentUrl, "success"))).data.RspCode).toBe("00");
        const unpaid = await flow.client.placeOrder([["Đen/S", 1]], "vnpay");

        // Hoàn 100.000 qua cổng (dưới ngưỡng → kế toán tự duyệt) rồi thực hiện → x_refund succeeded.
        const refundGateway = new MockVnpayRefundGateway(DEV_VNPAY);
        setRefundGatewayForTest(refundGateway);
        const created = await flow.admin(
          "/admin/x/refunds",
          A("accountant"),
          { order_id: paid.orderId, reason: "other", amount: 100_000, note: "Bù chênh lệch" },
          { "Idempotency-Key": key() },
        );
        expect(created.status).toBe(201);
        const exec = await flow.admin(`/admin/x/refunds/${created.data.refund.id}/execute`, A("accountant"));
        expect(exec.data.outcome).toBe("succeeded");
        const refund = await container
          .resolve<ReturnsModuleService>(RETURNS_MODULE)
          .getRefund(created.data.refund.id);

        const at = new Date();
        const r1 = await importCsv(
          A("accountant"),
          "vnpay",
          csvOf(
            line(await txnRefOf(paid.orderId), paid.total, "payment", at),
            line(await txnRefOf(late.orderId), late.total, "payment", at),
            line(await txnRefOf(unpaid.orderId), unpaid.total, "payment", at),
            line(refund!.provider_request_id, 100_000, "refund", at),
          ),
        );
        expect(r1.status).toBe(201);
        const results = Object.fromEntries((r1.data.lines as J[]).map((l) => [l.order_id, l.result]));
        expect(results).toEqual({
          [paid.orderId]: "matched",
          [late.orderId]: "late_after_cancel",
          [unpaid.orderId]: "unexpected",
        });
        expect((r1.data.lines as J[]).filter((l) => l.type === "refund")).toEqual([
          expect.objectContaining({ result: "matched", target_kind: "refund", target_id: refund!.id }),
        ]);
        const lateDisc = (r1.data.discrepancies as J[]).find((d) => d.kind === "late_after_cancel")!;
        expect(lateDisc).toMatchObject({ order_id: late.orderId, amount: late.total, priority: "high" });

        // Cùng giao dịch xuất hiện ở sao kê khác (thời điểm khác → chứng từ khác) → thu dư.
        const r2 = await importCsv(
          A("accountant"),
          "vnpay",
          csvOf(line(await txnRefOf(paid.orderId), paid.total, "payment", new Date(at.getTime() + 60_000))),
        );
        expect(r2.status).toBe(201);
        expect(r2.data.discrepancies).toEqual([
          expect.objectContaining({
            kind: "overpaid",
            order_id: paid.orderId,
            amount: paid.total,
            priority: "high",
          }),
        ]);

        // Đơn đã trả online đủ (COD = 0) mà hãng vẫn thu tiền khi giao → thu dư (AT13).
        const prepaid = await flow.place([["Trắng/M", 1]], "vnpay");
        const s = (await flow.deliver(prepaid)) as {
          id: string;
          client_order_code: string;
          cod_amount: number;
        };
        expect(s.cod_amount).toBe(0);
        const r3 = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(s.client_order_code, 200_000, "cod")),
        );
        expect(r3.data.lines[0]).toMatchObject({ result: "overpaid", target_id: s.id });
        // Hãng thu tiền không được thu → vận đơn `disputed` (không phải settled) cho tới khi xử lý chênh lệch.
        expect(await settlementState(s.id)).toBe("disputed");
      });
    });

    describe("ca biên file — không ghi gì khi lỗi", () => {
      it("rỗng, chỉ header, dòng sai (âm, thập phân, phân cách, công thức, múi giờ, loại), sai MIME/nhị phân/quá cỡ/tham số", async () => {
        const { o, s } = await deliveredCod();
        const ok = line(s.client_order_code, o.total, "cod");
        const expectRejected = async (r: Res, status: number, code: string) => {
          expect({ status: r.status, code: r.data.code }).toEqual({ status, code });
          expect(r.headers["content-type"]).toContain("application/problem+json");
        };

        await expectRejected(await importCsv(A("accountant"), "ghn_cod", ""), 422, "EMPTY_FILE");
        await expectRejected(await importCsv(A("accountant"), "ghn_cod", `${HEADER}\n`), 422, "EMPTY_BATCH");
        const bad = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(
            ok,
            line("NEG-1", -5000, "cod"),
            line("DEC-1", "1000.5", "cod"),
            line("SEP-1", "1.000", "cod"),
            line("=cmd|'/c calc'!A0", 1000, "cod"),
            `TZ-1,1000,2026-10-25T08:00:00,cod`,
            line("TYPE-1", 1000, "payment"),
          ),
        );
        await expectRejected(bad, 422, "INVALID_ROWS");
        expect((bad.data.row_errors as J[]).map((e) => [e.line, e.column])).toEqual([
          [3, "amount"],
          [4, "amount"],
          [5, "amount"],
          [6, "reference"],
          [7, "occurred_at"],
          [8, "type"],
        ]);
        expect(JSON.stringify(bad.data)).not.toContain("calc");

        await expectRejected(
          await importCsv(A("accountant"), "ghn_cod", JSON.stringify({ csv: ok }), {}, "application/json"),
          415,
          "UNSUPPORTED_MEDIA_TYPE",
        );
        await expectRejected(
          await importCsv(A("accountant"), "ghn_cod", `${HEADER}\n\u0000\u0001${ok}\n`),
          415,
          "UNSUPPORTED_MEDIA_TYPE",
        );
        await expectRejected(
          await importCsv(
            A("accountant"),
            "ghn_cod",
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
          ),
          422,
          "INVALID_ENCODING",
        );
        const big = csvOf(ok) + "#".repeat(1024 * 1024);
        await expectRejected(await importCsv(A("accountant"), "ghn_cod", big), 413, "FILE_TOO_LARGE");

        const form = new FormData();
        form.append("file", new Blob([csvOf(ok)], { type: "text/csv" }), "bang-ke.exe");
        const exe = (await api.post("/admin/x/settlements/batches?source=ghn_cod", form, {
          headers: A("accountant"),
          validateStatus: () => true,
        })) as Res;
        await expectRejected(exe, 415, "UNSUPPORTED_MEDIA_TYPE");

        for (const params of [
          {},
          { source: "momo" },
          { source: "ghn_cod", period_end: "2026-10-25T00:00:00" },
          { source: "ghn_cod", external_ref: "=HACK" },
          { source: "ghn_cod", la: "1" },
        ]) {
          const r = (await api.post(
            `/admin/x/settlements/batches?${new URLSearchParams(params as Record<string, string>).toString()}`,
            csvOf(ok),
            { headers: { ...A("accountant"), "content-type": "text/csv" }, validateStatus: () => true },
          )) as Res;
          expect({ params, status: r.status, code: r.data.code }).toEqual({
            params,
            status: 422,
            code: "VALIDATION",
          });
        }

        expect((await settlement().listBatches({}, { limit: 10, offset: 0 })).count).toBe(0);
        expect(await settlementState(s.id)).toBe("unsettled");

        // Multipart hợp lệ (trường `file`, đuôi .csv) vẫn nhập được.
        const good = new FormData();
        good.append("file", new Blob([csvOf(ok)], { type: "text/csv" }), "bang-ke.csv");
        const viaForm = (await api.post("/admin/x/settlements/batches?source=ghn_cod", good, {
          headers: A("accountant"),
          validateStatus: () => true,
        })) as Res;
        expect(viaForm.status).toBe(201);
      });
    });

    describe("đồng thời", () => {
      it("5 lần nhập cùng batch song song → 1 batch (201 + 200×4); hai batch khác nhau cùng đơn song song → một khớp, một thu dư", async () => {
        const { o, s } = await deliveredCod();
        const csv = csvOf(line(s.client_order_code, o.total, "cod"));
        const results = await Promise.all(
          Array.from({ length: 5 }, () => importCsv(A("accountant"), "ghn_cod", csv)),
        );
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
        expect(new Set(results.map((r) => r.data.batch.id)).size).toBe(1);
        expect((await settlement().listBatches({}, { limit: 10, offset: 0 })).count).toBe(1);

        const two = await deliveredCod([["Trắng/M", 1]]);
        const base = Date.now();
        const pair = await Promise.all(
          [0, 1].map((i) =>
            importCsv(
              A("accountant"),
              "ghn_cod",
              csvOf(line(two.s.client_order_code, two.o.total, "cod", new Date(base - i * 1000))),
            ),
          ),
        );
        expect(pair.map((r) => r.status)).toEqual([201, 201]);
        expect(pair.map((r) => r.data.lines[0].result).sort()).toEqual(["matched", "overpaid"]);
        expect(await settlementState(two.s.id)).toBe("settled");
      });

      it("mã batch của hãng đã nhập với nội dung khác → 409 BATCH_CONFLICT, không ghi", async () => {
        const { o, s } = await deliveredCod();
        const first = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(s.client_order_code, o.total, "cod")),
          {
            external_ref: "GHN-BATCH-1",
          },
        );
        expect(first.status).toBe(201);
        const other = await importCsv(
          A("accountant"),
          "ghn_cod",
          csvOf(line(s.client_order_code, 1, "cod")),
          {
            external_ref: "GHN-BATCH-1",
          },
        );
        expect(other).toMatchObject({
          status: 409,
          data: { code: "BATCH_CONFLICT", batch_id: first.data.batch.id },
        });
        expect((await settlement().listBatches({}, { limit: 10, offset: 0 })).count).toBe(1);
        // Cùng mã ở nguồn khác là batch khác.
        const otherSource = await importCsv(
          A("accountant"),
          "vnpay",
          csvOf(line("VNP-KHONG-CO-1", 1000, "payment")),
          {
            external_ref: "GHN-BATCH-1",
          },
        );
        expect(otherSource.status).toBe(201);
        expect((await settlement().listBatches({}, { limit: 10, offset: 0 })).count).toBe(2);
      });

      it("hai kế toán đóng cùng chênh lệch song song → một 200, một 409; lịch sử chỉ một lần đóng", async () => {
        const r = await importCsv(A("accountant"), "ghn_cod", csvOf(line("MA-LA-SONG-SONG", 70_000, "cod")));
        expect(r.status).toBe(201);
        const id = (r.data.discrepancies as J[])[0]!.id as string;
        const path = `/admin/x/settlements/discrepancies/${id}/resolve`;
        const both = await Promise.all(
          ["Đóng lần A", "Đóng lần B"].map((note) => flow.admin(path, A("accountant"), { note })),
        );
        expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
        const list = await get(`/admin/x/settlements/discrepancies?batch_id=${r.data.batch.id}`);
        expect(list.data.discrepancies[0].events.map((e: J) => e.action)).toEqual(["opened", "resolved"]);
      });
    });

    describe("phân quyền", () => {
      it("kế toán nhập/đọc được; kho, CSKH, nhân viên đơn → 403 problem+json", async () => {
        const { o, s } = await deliveredCod();
        const csv = csvOf(line(s.client_order_code, o.total, "cod"));
        for (const role of ["warehouse", "support", "order_staff"] as const) {
          const denied = await importCsv(A(role), "ghn_cod", csv);
          expect({ role, status: denied.status, code: denied.data.code }).toEqual({
            role,
            status: 403,
            code: "FORBIDDEN",
          });
          expect(denied.headers["content-type"]).toContain("application/problem+json");
          for (const path of ["/admin/x/settlements/batches", "/admin/x/settlements/discrepancies"]) {
            expect({ role, path, status: (await get(path, A(role))).status }).toEqual({
              role,
              path,
              status: 403,
            });
          }
        }
        expect((await settlement().listBatches({}, { limit: 10, offset: 0 })).count).toBe(0);
        const ok = await importCsv(A("accountant"), "ghn_cod", csv);
        expect(ok.status).toBe(201);
        const list = await get("/admin/x/settlements/batches?source=ghn_cod");
        expect(list.data).toMatchObject({ count: 1, batches: [{ id: ok.data.batch.id }] });
        expect((await get("/admin/x/settlements/batches/khong-co")).status).toBe(404);
      });
    });
  },
});
