import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { Migration20261026020000 } from "../../src/modules/returns/migrations/Migration20261026020000";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { DEV_VNPAY, type Api } from "../helpers/checkout-api";
import { seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/**
 * T-054 — ghi chú/lý do tự do (khách hoặc nhân viên nhập) không lộ PII: che khi TRẢ RA (Admin/Store) và khi GHI audit;
 * dữ liệu gốc trong bảng nghiệp vụ giữ nguyên. Cộng chỉ mục `x_refund(state, created_at)` (up/down).
 */
const PII_NOTE =
  "Gọi 0912345678 hoặc +84 912 345 678, mail lan.nguyen@example.com, giao số nhà 12 ngõ 5 Lý Thường Kiệt, Hà Nội";
const PLAIN_NOTE = "Áo bị rách đường chỉ — khách muốn đổi, hoàn 250.000đ";
const LEAKS = ["0912345678", "912 345 678", "lan.nguyen@example.com", "Lý Thường Kiệt", "ngõ 5"];
const expectMasked = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const leak of LEAKS) expect(text).not.toContain(leak);
};

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"order_staff" | "support" | "accountant" | "owner", MfaAdmin>;
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.order_staff.headers,
      ip: () => ip,
    });
    const A = (role: keyof typeof staff) => staff[role].headers;
    const pg = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;
    const auditOf = async (resourceType: string, resourceId: string) =>
      (
        await container
          .resolve<AuditModuleService>(AUDIT_MODULE)
          .list({ resource_type: resourceType, resource_id: resourceId }, { limit: 50, offset: 0 })
      ).entries;

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["order_staff", "support", "accountant", "owner"] as const) {
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

    it("returns: note khách → che ở phản hồi tạo/chi tiết Admin; từ chối kèm lý do PII → che cả decision_note và audit; bảng giữ nguyên", async () => {
      const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
      const created = await flow.requestReturn(o, {
        kind: "return",
        reason: "changed_mind",
        note: PII_NOTE,
        lines: [{ line_id: await lineOf(o.orderId, "Đen/M"), quantity: 1 }],
      });
      expect(created.status).toBe(201);
      expectMasked(created.data);
      expect(created.data.return.note).toContain("091****678");
      expect(created.data.return.note).toContain("l***@example.com");
      const id = created.data.return.id as string;

      const detail = await flow.adminGet(`/admin/x/returns/${id}`, A("owner"));
      expect(detail.status).toBe(200);
      expectMasked(detail.data);
      // Dữ liệu gốc không bị phá.
      expect((await pg()("x_return").where({ id }).first()).note).toBe(PII_NOTE);

      const rejected = await flow.admin(`/admin/x/returns/${id}/reject`, A("support"), { reason: PII_NOTE });
      expect(rejected.status).toBe(200);
      expectMasked(rejected.data);
      expectMasked((await flow.adminGet(`/admin/x/returns/${id}`, A("owner"))).data);
      for (const e of await auditOf("return", id)) expectMasked(e);
    });

    it("returns: note không có PII giữ nguyên (Unicode tiếng Việt không vỡ)", async () => {
      const o = await flow.deliveredOrder([["Đen/M", 1]], "vnpay");
      const created = await flow.requestReturn(o, {
        kind: "return",
        reason: "changed_mind",
        note: PLAIN_NOTE,
        lines: [{ line_id: await lineOf(o.orderId, "Đen/M"), quantity: 1 }],
      });
      expect(created.data.return.note).toBe(PLAIN_NOTE);
      const detail = await flow.adminGet(`/admin/x/returns/${created.data.return.id}`, A("owner"));
      expect(detail.data.return.note).toBe(PLAIN_NOTE);
    });

    it("refunds: note/reject_reason che ở phản hồi + hàng đợi + audit; bảng giữ nguyên", async () => {
      const o = await flow.place([["Đen/M", 1]], "vnpay");
      const made = await flow.admin(
        "/admin/x/refunds",
        A("support"),
        { order_id: o.orderId, reason: "other", amount: 50_000, note: PII_NOTE },
        { "Idempotency-Key": key() },
      );
      expect(made.status).toBe(201);
      expectMasked(made.data);
      const id = made.data.refund.id as string;
      expect((await pg()("x_refund").where({ id }).first()).note).toBe(PII_NOTE);

      const queue = await flow.adminGet("/admin/x/refunds?state=requested", A("accountant"));
      expect(queue.status).toBe(200);
      expectMasked(queue.data);
      expect(JSON.stringify(queue.data)).toContain("091****678");

      const rejected = await flow.admin(`/admin/x/refunds/${id}/reject`, A("accountant"), {
        reason: PII_NOTE,
      });
      expect(rejected.status).toBe(200);
      expectMasked(rejected.data);
      for (const e of await auditOf("refund", id)) expectMasked(e);
    });

    it("hủy đơn bởi nhân viên: lý do PII → audit đã che", async () => {
      const o = await flow.place([["Đen/S", 1]], "cod");
      const r = await flow.admin(
        `/admin/x/orders/${o.orderId}/cancel`,
        A("order_staff"),
        { reason: PII_NOTE },
        { "Idempotency-Key": key() },
      );
      expect(r.status).toBe(200);
      const entries = await auditOf("order", o.orderId);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expectMasked(e);
      expect(entries.some((e) => (e.reason ?? "").includes("091****678"))).toBe(true);
    });

    describe("index x_refund(state, created_at)", () => {
      const indexDef = async () =>
        (
          await pg().raw(
            `select indexdef from pg_indexes where tablename = 'x_refund' and indexname = 'IDX_x_refund_state_created'`,
          )
        ).rows as Array<{ indexdef: string }>;
      const run = async (direction: "up" | "down") => {
        const m = new Migration20261026020000({} as never, {} as never);
        await m[direction]();
        for (const q of m.getQueries()) await pg().raw(String(q));
      };

      it("tồn tại sau migrate; down gỡ sạch; up lại không lỗi", async () => {
        const rows = await indexDef();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.indexdef).toContain("(state, created_at)");
        try {
          await run("down");
          expect(await indexDef()).toHaveLength(0);
        } finally {
          await run("up");
        }
        expect(await indexDef()).toHaveLength(1);
        await run("up");
        expect(await indexDef()).toHaveLength(1);
      });
    });
  },
});
