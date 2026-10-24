import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { recordAudit } from "../../src/lib/audit/record";
import { createAdmin, noThrow, type AdminAccount } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}
type Row = Record<string, unknown>;

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let owner: AdminAccount;
    let accountant: AdminAccount;

    beforeAll(async () => {
      container = getContainer();
      owner = await createAdmin(rawApi, container, { roles: ["owner"] });
      accountant = await createAdmin(rawApi, container, { roles: ["accountant"] });
    });

    const get = (url: string, who: AdminAccount, headers: Record<string, string> = {}) =>
      api.request({ method: "GET", url, headers: { ...who.headers, ...headers }, ...noThrow });

    it("GET /admin/x/audit: owner đọc được, mới nhất trước, phân trang limit/offset + count, lọc theo action", async () => {
      for (let i = 0; i < 5; i++) {
        await recordAudit(container, {
          actor_type: "system",
          actor_id: "test",
          action: "test.event",
          resource_type: "thing",
          resource_id: `t${i}`,
        });
      }
      const page1 = await get("/admin/x/audit?action=test.event&limit=2", owner);
      expect(page1.status).toBe(200);
      expect(page1.headers["cache-control"]).toBe("no-store");
      expect(page1.data).toMatchObject({ count: 5, limit: 2, offset: 0 });
      expect((page1.data.audit_logs as Row[]).map((r) => r.resource_id)).toEqual(["t4", "t3"]);
      const page3 = await get("/admin/x/audit?action=test.event&limit=2&offset=4", owner);
      expect((page3.data.audit_logs as Row[]).map((r) => r.resource_id)).toEqual(["t0"]);
      const empty = await get("/admin/x/audit?action=khong-co", owner);
      expect(empty.data).toMatchObject({ count: 0, audit_logs: [] });
    });

    it("tham số sai → 422; vai trò không có audit.read → 403 (và chính lần đó được ghi audit)", async () => {
      for (const q of ["limit=0", "limit=101", "offset=-1", "limit=abc", "la=1"]) {
        expect({ q, status: (await get(`/admin/x/audit?${q}`, owner)).status }).toEqual({ q, status: 422 });
      }
      const denied = await get("/admin/x/audit", accountant, { "x-request-id": "req-audit-123" });
      expect(denied).toMatchObject({ status: 403, data: { code: "FORBIDDEN", permission: "audit.read" } });
      const log = await get(`/admin/x/audit?action=rbac.denied&actor_id=${accountant.userId}`, owner);
      const [row] = log.data.audit_logs as Row[];
      expect(row).toMatchObject({ resource_id: "GET /admin/x/audit", request_id: "req-audit-123" });
      // IP chỉ lưu dạng băm, không lưu thô.
      expect(row?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
    });

    it("không có route sửa/xoá audit (403 fail-closed); DB chặn UPDATE/DELETE", async () => {
      for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
        const res = await api.request({
          method,
          url: "/admin/x/audit",
          headers: owner.headers,
          data: {},
          ...noThrow,
        });
        expect({ method, status: res.status }).toEqual({ method, status: 403 });
      }
      await recordAudit(container, { actor_type: "system", action: "x", resource_type: "y" });
      const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      await expect(pg.raw(`UPDATE audit_log SET action = 'sua'`)).rejects.toThrow(/append-only/);
      await expect(pg.raw(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    });

    it("changes được che PII trước khi ghi (email/điện thoại/địa chỉ/bí mật)", async () => {
      await recordAudit(container, {
        actor_type: "system",
        action: "test.pii",
        resource_type: "customer",
        resource_id: "cus_1",
        changes: {
          email: "nguyen.van.a@example.vn",
          phone: "0912345678",
          shipping_address: { address_1: "12 Lý Thái Tổ" },
          password: "bi-mat",
          note: "gọi 0987654321",
        },
      });
      const res = await get("/admin/x/audit?action=test.pii", owner);
      const changes = (res.data.audit_logs as Row[])[0]?.changes as Row;
      expect(changes).toEqual({
        email: "n***@example.vn",
        phone: "091****678",
        shipping_address: "[PII]",
        password: "[REDACTED]",
        note: "gọi 098****321",
      });
      expect(JSON.stringify(res.data)).not.toContain("nguyen.van.a@");
    });
  },
});
