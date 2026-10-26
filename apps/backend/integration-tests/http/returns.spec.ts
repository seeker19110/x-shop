import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { reviseSizeChartWorkflow } from "../../src/workflows/fashion/size-chart";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { TEST_CHART } from "../helpers/catalog";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import {
  countOrders,
  createPromotion,
  inventoryLevel,
  seedCatalog,
  setStock,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-027 — đổi trả theo dòng (POST03), kiểm định trước restock (INV04, AT17), hoàn theo giá thực trả (AT15), đổi size
 * bằng đơn thay thế có giữ hàng (S-310), snapshot phiên bản bảng size vào dòng đơn (ADM03). Đi qua HTTP thật + luồng
 * đơn thật (submit → IPN/xác nhận COD → vận đơn GHN mock → callback đã giao).
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

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const returns = () => container.resolve<ReturnsModuleService>(RETURNS_MODULE);

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
      clearShippingFeeCache();
      refundGateway = new MockVnpayRefundGateway(DEV_VNPAY);
      setRefundGatewayForTest(refundGateway);
      ip = newIp();
    });

    /** variant id → id dòng đơn native (+ metadata) của đơn. */
    async function itemsOf(orderId: string) {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "total", "items.id", "items.variant_id", "items.unit_price", "items.metadata"],
        filters: { id: orderId },
      });
      const order = data[0] as {
        total: unknown;
        items: Array<{ id: string; variant_id: string; unit_price: unknown; metadata: J }>;
      };
      return { total: Number(order.total), items: order.items };
    }
    const lineOf = async (orderId: string, variantKey: string) => {
      const { items } = await itemsOf(orderId);
      return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
    };
    const quarantineStock = async (variantKey: string) => {
      const [lv] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
        location_id: fx.quarantineLocationId,
      });
      return lv ? Number(lv.stocked_quantity) : 0;
    };
    const A = (role: keyof typeof staff) => staff[role].headers;

    /** Đơn VNPAY 700.000 + 300.000, mã giảm 10% = 100.000 phân bổ 70.000 + 30.000 (AT15), đã giao. */
    async function at15Order(): Promise<PlacedOrder> {
      const code = `GIAM10-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      await createPromotion(container, code, { limit: null, percent: 10 });
      return flow.deliveredOrder(
        [
          ["Đen/M", 1],
          ["Trắng/S", 1],
        ],
        "vnpay",
        { discount_code: code },
      );
    }

    describe("snapshot bảng size vào dòng đơn (ADM03)", () => {
      it("dòng đơn mang id/code/version bảng size lúc mua; đổi bảng size sau đó không đổi đơn cũ", async () => {
        const first = await flow.place([["Đen/M", 1]], "cod");
        const before = (await itemsOf(first.orderId)).items[0]!.metadata;
        expect(before).toMatchObject({ size_chart_version: 1 });
        expect(before.size_chart_id).toMatch(/^szc_/);
        const chartCode = before.size_chart_code as string;
        expect(chartCode).toMatch(/^ao-thun-/);

        await reviseSizeChartWorkflow(container).run({ input: { code: chartCode, ...TEST_CHART } });
        const second = await flow.place([["Đen/M", 1]], "cod");
        const after = (await itemsOf(second.orderId)).items[0]!.metadata;
        expect(after).toMatchObject({ size_chart_code: chartCode, size_chart_version: 2 });
        expect(after.size_chart_id).not.toBe(before.size_chart_id);
        // Đơn cũ giữ đúng phiên bản đã xem lúc mua.
        expect((await itemsOf(first.orderId)).items[0]!.metadata).toMatchObject({
          size_chart_id: before.size_chart_id,
          size_chart_version: 1,
        });
        // Yêu cầu trả của dòng mang theo snapshot đó.
        await flow.deliver(first);
        const req = await flow.requestReturn(first, {
          kind: "return",
          reason: "wrong_size",
          lines: [{ line_id: await lineOf(first.orderId, "Đen/M"), quantity: 1 }],
        });
        expect(req.status).toBe(201);
        expect(req.data.return.lines[0].size_chart).toEqual({
          id: before.size_chart_id,
          code: chartCode,
          version: 1,
        });
      });
    });

    describe("AT15 + AT17 — trả một trong hai món, hoàn đúng phần thực trả, chưa kiểm định thì không tăng tồn bán", () => {
      it("[api5-bfla post /admin/x/returns/{id}/approve, post /admin/x/returns/{id}/receive, post /admin/x/returns/{id}/inspect] trả món 300.000 (giảm phân bổ 30.000) → hoàn 270.000; nhận hàng vào kho cách ly; restock chỉ sau kiểm định đạt", async () => {
        const o = await at15Order();
        expect(o.total).toBe(930_000); // 1.000.000 − 100.000 + phí ship 30.000
        const blackLine = await lineOf(o.orderId, "Đen/M");
        const whiteLine = await lineOf(o.orderId, "Trắng/S");

        const view = await flow.storeReturns(o);
        expect(view.status).toBe(200);
        expect(view.headers["cache-control"]).toBe("private, no-store");
        expect(view.data).toMatchObject({ can_request: true, returns: [] });
        expect(view.data.lines).toHaveLength(2);

        const req = await flow.requestReturn(o, {
          kind: "return",
          reason: "changed_mind",
          note: "Không hợp màu",
          lines: [{ line_id: whiteLine, quantity: 1 }],
        });
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;
        expect(req.data.return).toMatchObject({
          state: "requested",
          status_label: "Đã tiếp nhận",
          refund: null,
        });
        expect(req.data.return.order_id).toBeUndefined(); // khách không thấy id nội bộ

        // Quyền: kho không duyệt được; CSKH duyệt được.
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("warehouse"))).status).toBe(403);
        const approved = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        expect(approved.status).toBe(200);
        expect(approved.data.return.state).toBe("approved");

        // AT17: nhận hàng → kho cách ly +1, tồn bán KHÔNG đổi. CSKH không nhận hàng được.
        const sellableBefore = await inventoryLevel(container, fx, "Trắng/S");
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("support"))).status).toBe(403);
        const received = await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        expect(received.status).toBe(200);
        expect(received.data.return).toMatchObject({ state: "received", status_label: "Đã nhận hàng" });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual(sellableBefore);
        expect(await quarantineStock("Trắng/S")).toBe(1);
        // Gửi lại → idempotent, không cộng cách ly lần hai.
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).data.changed).toBe(
          false,
        );
        expect(await quarantineStock("Trắng/S")).toBe(1);

        // Kiểm định đạt → chuyển cách ly → tồn bán (+1), mở hoàn 270.000 theo giá thực trả.
        expect(
          (
            await flow.admin(`/admin/x/returns/${retId}/inspect`, A("support"), {
              lines: [{ line_id: whiteLine, restock_quantity: 1, damaged_quantity: 0 }],
            })
          ).status,
        ).toBe(403);
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: whiteLine, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.status).toBe(200);
        expect(inspected.data.return.lines[0]).toMatchObject({ restock_quantity: 1, refund_amount: 270_000 });
        expect(inspected.data.refund).toMatchObject({
          amount: 270_000,
          reason: "return",
          method: "provider",
          state: "requested", // kho tạo (không có refund.approve) → chờ người duyệt
          approval_required: false,
        });
        expect(Number.isSafeInteger(inspected.data.refund.amount)).toBe(true);
        expect((await inventoryLevel(container, fx, "Trắng/S")).stocked).toBe(sellableBefore.stocked + 1);
        expect(await quarantineStock("Trắng/S")).toBe(0);

        // Gửi lại cùng kết quả → không restock lần hai, không mở hoàn thứ hai.
        const again = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: whiteLine, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(again.data).toMatchObject({ changed: false, refund: { id: inspected.data.refund.id } });
        expect((await inventoryLevel(container, fx, "Trắng/S")).stocked).toBe(sellableBefore.stocked + 1);

        // Kế toán duyệt + thực hiện → cổng hoàn đúng 270.000 một lần; yêu cầu trả đóng.
        const refundId = inspected.data.refund.id as string;
        expect((await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("accountant"))).status).toBe(200);
        const exec = await flow.admin(`/admin/x/refunds/${refundId}/execute`, A("accountant"));
        expect(exec.status).toBe(200);
        expect(exec.data).toMatchObject({
          outcome: "succeeded",
          refund: { state: "succeeded", amount: 270_000 },
        });
        expect(refundGateway.totalRefunded()).toBe(270_000);
        expect(refundGateway.bodies[0]).toMatchObject({ vnp_Amount: "27000000", vnp_TransactionType: "03" });

        const ledger = await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" });
        expect(ledger.map((l) => Number(l.amount))).toEqual([270_000]);
        const final = await flow.storeReturns(o);
        expect(final.data.returns[0]).toMatchObject({
          state: "closed",
          status_label: "Hoàn tất",
          refund: { amount: 270_000, state: "succeeded", status_label: "Đã hoàn tiền" },
        });
        // Món còn lại giữ nguyên: vẫn trả được 1, món đã trả còn 0.
        const lines = final.data.lines as Array<{ line_id: string; returnable_quantity: number }>;
        expect(lines.find((l) => l.line_id === blackLine)!.returnable_quantity).toBe(1);
        expect(lines.find((l) => l.line_id === whiteLine)!.returnable_quantity).toBe(0);
        const summary = await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("accountant"));
        expect(summary.data).toMatchObject({
          captured: 930_000,
          refunded: 270_000,
          held: 0,
          refundable: 660_000,
        });
      });

      it("hàng lỗi không restock: 2 món, 1 đạt + 1 lỗi → tồn bán +1, cách ly giữ 1; cả hai được hoàn; khác kết quả → 409", async () => {
        const o = await flow.deliveredOrder([["Trắng/S", 2]], "vnpay");
        const line = await lineOf(o.orderId, "Trắng/S");
        const req = await flow.requestReturn(o, {
          kind: "return",
          reason: "defective",
          lines: [{ line_id: line, quantity: 2 }],
        });
        const retId = req.data.return.id as string;
        await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        const before = await inventoryLevel(container, fx, "Trắng/S");
        expect(await quarantineStock("Trắng/S")).toBe(2);

        // Đạt + lỗi > đã nhận → 422.
        const bad = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 2, damaged_quantity: 1 }],
        });
        expect(bad.status).toBe(422);

        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 1, note: "Rách đường may" }],
        });
        expect(inspected.status).toBe(200);
        expect((await inventoryLevel(container, fx, "Trắng/S")).stocked).toBe(before.stocked + 1);
        expect(await quarantineStock("Trắng/S")).toBe(1); // hàng lỗi ở lại kho cách ly
        expect(inspected.data.refund.amount).toBe(600_000);

        const different = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 2, damaged_quantity: 0 }],
        });
        expect(different).toMatchObject({ status: 409, data: { code: "INVALID_STATE" } });
        expect((await inventoryLevel(container, fx, "Trắng/S")).stocked).toBe(before.stocked + 1);
      });

      it("không đạt điều kiện: không hoàn, không restock, rời kho cách ly; yêu cầu đóng ngay", async () => {
        const o = await flow.deliveredOrder([["Trắng/S", 1]], "vnpay");
        const line = await lineOf(o.orderId, "Trắng/S");
        const retId = (
          await flow.requestReturn(o, {
            kind: "return",
            reason: "changed_mind",
            lines: [{ line_id: line, quantity: 1 }],
          })
        ).data.return.id as string;
        await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        const before = await inventoryLevel(container, fx, "Trắng/S");
        const r = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 0, damaged_quantity: 0, note: "Đã qua sử dụng" }],
        });
        expect(r.data).toMatchObject({ refund: null, return: { state: "closed" } });
        expect(r.data.return.lines[0]).toMatchObject({ rejected_quantity: 1, refund_amount: 0 });
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual(before);
        expect(await quarantineStock("Trắng/S")).toBe(0);
      });

      it("hai lần trả cùng một dòng cộng lại đúng bằng phần thực trả (lũy kế, không lệch đồng nào)", async () => {
        const code = `GIAM10-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        await createPromotion(container, code, { limit: null, percent: 10 });
        // 3 × 300.000 + 1 × 700.000 = 1.600.000, giảm 160.000 → dòng trắng thực trả 810.000 (270.000/món).
        const o = await flow.deliveredOrder(
          [
            ["Trắng/S", 3],
            ["Đen/M", 1],
          ],
          "vnpay",
          { discount_code: code },
        );
        const line = await lineOf(o.orderId, "Trắng/S");
        const amounts: number[] = [];
        for (const qty of [1, 2]) {
          const retId = (
            await flow.requestReturn(o, {
              kind: "return",
              reason: "wrong_size",
              lines: [{ line_id: line, quantity: qty }],
            })
          ).data.return.id as string;
          await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
          await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
          const r = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
            lines: [{ line_id: line, restock_quantity: qty, damaged_quantity: 0 }],
          });
          amounts.push(r.data.refund.amount as number);
        }
        const fin = (await checkout().listOrderFinances({ order_id: o.orderId }))[0]!;
        const quoteLine = (
          fin.quote as unknown as { lines: Array<{ lineTotal: number; quantity: number }> }
        ).lines.find((l) => l.quantity === 3)!;
        expect(amounts.reduce((a, b) => a + b, 0)).toBe(quoteLine.lineTotal);
        expect(amounts).toEqual([270_000, 540_000]);
      });
    });

    describe("yêu cầu đổi/trả — quyền, ca biên, idempotency, đồng thời", () => {
      it("[api1-bola post /store/x/orders/{display_ref}/returns] đơn chưa giao → 409 NOT_RETURNABLE; token sai → 404; trả vượt số đã giao → 422", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const line = await lineOf(o.orderId, "Đen/M");
        const notYet = await flow.requestReturn(o, {
          kind: "return",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 1 }],
        });
        expect(notYet).toMatchObject({ status: 409, data: { code: "NOT_RETURNABLE" } });
        expect((await flow.storeReturns(o)).data.can_request).toBe(false);
        await flow.deliver(o);

        const wrongToken = await flow.requestReturn(
          { ...o, access: "khong-hop-le" },
          { kind: "return", reason: "wrong_size", lines: [{ line_id: line, quantity: 1 }] },
        );
        expect(wrongToken.status).toBe(404);

        const tooMany = await flow.requestReturn(o, {
          kind: "return",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 2 }],
        });
        expect(tooMany).toMatchObject({
          status: 422,
          data: { code: "QUANTITY_EXCEEDS_DELIVERED", returnable: 1 },
        });
        for (const body of [
          { kind: "return", reason: "wrong_size", lines: [] },
          { kind: "return", reason: "wrong_size", lines: [{ line_id: line, quantity: 0 }] },
          { kind: "return", reason: "wrong_size", lines: [{ line_id: line, quantity: 1.5 }] },
          { kind: "return", reason: "khac", lines: [{ line_id: line, quantity: 1 }] },
          { kind: "return", reason: "wrong_size", lines: [{ line_id: "dong-la", quantity: 1 }] },
        ]) {
          expect((await flow.requestReturn(o, body)).status).toBe(422);
        }
        // Thiếu Idempotency-Key → 422.
        const noKey = await api.post(
          `/store/x/orders/${o.ref}/returns`,
          {},
          {
            headers: {
              "x-publishable-api-key": fx.publishableKey,
              "x-order-access": o.access,
              "x-forwarded-for": ip,
            },
            validateStatus: () => true,
          },
        );
        expect(noKey.status).toBe(422);
      });

      it("cùng Idempotency-Key gửi lại → cùng yêu cầu (200); khác nội dung → 409; hai yêu cầu song song cho 1 món → đúng một thành công", async () => {
        const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
        const line = await lineOf(o.orderId, "Đen/M");
        const body = { kind: "return", reason: "wrong_size", lines: [{ line_id: line, quantity: 1 }] };
        const k = key();
        const replays = await Promise.all(Array.from({ length: 4 }, () => flow.requestReturn(o, body, k)));
        expect(replays.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
        expect(new Set(replays.map((r) => r.data.return.id)).size).toBe(1);
        const conflict = await flow.requestReturn(o, { ...body, reason: "defective" }, k);
        expect(conflict).toMatchObject({ status: 409, data: { code: "IDEMPOTENCY_CONFLICT" } });
        expect(await returns().listReturnsOfOrder(o.orderId)).toHaveLength(1);

        // Từ chối yêu cầu đầu → món trả lại được; rồi 2 yêu cầu khác khóa chạy song song → chỉ một qua.
        const rejected = await flow.admin(
          `/admin/x/returns/${replays[0]!.data.return.id}/reject`,
          A("support"),
          {
            reason: "Khách đổi ý",
          },
        );
        expect(rejected.data.return.state).toBe("rejected");
        const parallel = await Promise.all([flow.requestReturn(o, body), flow.requestReturn(o, body)]);
        expect(parallel.map((r) => r.status).sort()).toEqual([201, 422]);
        expect(parallel.find((r) => r.status === 422)!.data.code).toBe("QUANTITY_EXCEEDS_DELIVERED");
      });

      it("[api5-bfla post /admin/x/returns] CSKH tạo hộ (return.request); kho không tạo được; COD đã giao → hoàn ngoài hệ thống cần chứng từ", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const body = {
          order_id: o.orderId,
          kind: "return",
          reason: "defective",
          lines: [{ line_id: line, quantity: 1 }],
        };
        const denied = await flow.admin("/admin/x/returns", A("warehouse"), body, {
          "Idempotency-Key": key(),
        });
        expect(denied.status).toBe(403);
        const created = await flow.admin("/admin/x/returns", A("support"), body, {
          "Idempotency-Key": key(),
        });
        expect(created.status).toBe(201);
        expect(created.data.return).toMatchObject({ channel: "staff", requested_by: staff.support.userId });
        const retId = created.data.return.id as string;
        await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 0, damaged_quantity: 1 }],
        });
        // COD: tiền hãng thu hộ là khoản thu; không có giao dịch cổng → hoàn ngoài hệ thống.
        expect(inspected.data.refund).toMatchObject({
          amount: 700_000,
          method: "manual",
          state: "requested",
        });
        const refundId = inspected.data.refund.id as string;
        await flow.admin(`/admin/x/refunds/${refundId}/approve`, A("accountant"));
        const noEvidence = await flow.admin(`/admin/x/refunds/${refundId}/execute`, A("accountant"));
        expect(noEvidence).toMatchObject({ status: 422, data: { code: "VALIDATION" } });
        const done = await flow.admin(`/admin/x/refunds/${refundId}/execute`, A("accountant"), {
          evidence_ref: "CK-20261025-0001",
        });
        expect(done.data).toMatchObject({
          outcome: "succeeded",
          refund: { evidence_ref: "CK-20261025-0001" },
        });
        expect(refundGateway.calls).toBe(0);
        const ledger = await checkout().listPaymentLedgers({ order_id: o.orderId, kind: "refund" });
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ provider: "manual", state: "succeeded" });
      });
    });

    describe("đổi size bằng đơn thay thế có giữ hàng (S-310)", () => {
      it("duyệt → đơn thay thế 0 đ giữ hàng size mới; dòng lịch sử không đổi; kiểm định đạt → đơn thay thế được xác nhận", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const ordersBefore = await countOrders(container);
        const reservedBefore = (await inventoryLevel(container, fx, "Đen/M")).reserved;

        const price = await flow.requestReturn(o, {
          kind: "exchange",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Trắng/S"]!.id }],
        });
        expect(price).toMatchObject({ status: 422, data: { code: "EXCHANGE_PRICE_DIFFERS" } });
        const same = await flow.requestReturn(o, {
          kind: "exchange",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/S"]!.id }],
        });
        expect(same).toMatchObject({ status: 422, data: { code: "EXCHANGE_INVALID_VARIANT" } });

        const req = await flow.requestReturn(o, {
          kind: "exchange",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/M"]!.id }],
        });
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;
        const approved = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        expect(approved.status).toBe(200);
        const replacementId = approved.data.return.replacement_order_id as string;
        expect(replacementId).toBeTruthy();
        expect(approved.data.return.replacement).toMatchObject({ state: "placed" });
        expect(await countOrders(container)).toBe(ordersBefore + 1);
        // Giữ hàng size mới gắn dòng của đơn thay thế.
        expect((await inventoryLevel(container, fx, "Đen/M")).reserved).toBe(reservedBefore + 1);
        const repl = await itemsOf(replacementId);
        expect(repl.total).toBe(0);
        expect(repl.items).toHaveLength(1);
        expect(repl.items[0]).toMatchObject({ variant_id: fx.variants["Đen/M"]!.id });
        expect(repl.items[0]!.metadata).toMatchObject({ x_return_id: retId, x_replaces_line_item_id: line });
        expect(repl.items[0]!.metadata.size_chart_version).toBe(1);
        const reservations = await container
          .resolve(Modules.INVENTORY)
          .listReservationItems({ line_item_id: repl.items[0]!.id });
        expect(reservations).toHaveLength(1);
        // Dòng lịch sử của đơn gốc giữ nguyên size cũ.
        expect((await itemsOf(o.orderId)).items[0]).toMatchObject({ variant_id: fx.variants["Đen/S"]!.id });
        // Duyệt lại → không tạo đơn thứ hai.
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).data.changed).toBe(
          false,
        );
        expect(await countOrders(container)).toBe(ordersBefore + 1);

        await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        const inspected = await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }],
        });
        expect(inspected.data).toMatchObject({ refund: null, return: { state: "closed" } });
        const fin = (await checkout().listOrderFinances({ order_id: replacementId }))[0]!;
        expect(fin.state).toBe("confirmed");
        expect(Number(fin.total)).toBe(0);
      });

      it("size mới hết hàng → 409 INSUFFICIENT_STOCK, yêu cầu vẫn chờ duyệt, không tạo đơn/giữ hàng", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const retId = (
          await flow.requestReturn(o, {
            kind: "exchange",
            reason: "wrong_size",
            lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/M"]!.id }],
          })
        ).data.return.id as string;
        await setStock(container, fx, "Đen/M", 0);
        const ordersBefore = await countOrders(container);
        const r = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        expect(r).toMatchObject({ status: 409, data: { code: "INSUFFICIENT_STOCK" } });
        expect((await returns().getReturn(retId))!.state).toBe("requested");
        expect(await countOrders(container)).toBe(ordersBefore);
        expect((await inventoryLevel(container, fx, "Đen/M")).reserved).toBe(0);
      });

      it("hàng trả không đạt → hủy đơn thay thế, nhả giữ hàng", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const retId = (
          await flow.requestReturn(o, {
            kind: "exchange",
            reason: "wrong_size",
            lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/M"]!.id }],
          })
        ).data.return.id as string;
        const approved = await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"));
        const replacementId = approved.data.return.replacement_order_id as string;
        await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"));
        await flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), {
          lines: [{ line_id: line, restock_quantity: 0, damaged_quantity: 0 }],
        });
        expect((await checkout().listOrderFinances({ order_id: replacementId }))[0]!.state).toBe("cancelled");
        expect((await container.resolve(Modules.ORDER).retrieveOrder(replacementId)).status).toBe("canceled");
        expect((await inventoryLevel(container, fx, "Đen/M")).reserved).toBe(0);
      });
    });
  },
});
