import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { can, ROLES, type Role } from "@x-shop/domain";
import {
  ADMIN_X_PERMISSIONS,
  requiredPermissions,
  type AdminXRoute,
} from "../../src/api/admin/x/permissions";
import { NATIVE_ADMIN_ROUTES } from "../../src/lib/admin-security/native-permissions";
import { resolveAdminRule } from "../../src/lib/admin-security/policy";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { RBAC_MODULE } from "../../src/modules/rbac";
import type RbacModuleService from "../../src/modules/rbac/service";
import grantOwner from "../../src/scripts/grant-owner";
import { createAdmin, createMfaAdmin, noThrow, type AdminAccount, type MfaAdmin } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

const ADMIN_X_DIR = join(__dirname, "../../src/api/admin/x");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Quét src/api/admin/x/**\/route.ts → (method, path Express) thật sự được Medusa nạp. */
function scanRouteFiles(): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^route\.(ts|js)$/.test(e.name)) {
        const rel = relative(ADMIN_X_DIR, dir).split(sep).filter(Boolean);
        const path = ["/admin/x", ...rel.map((s) => s.replace(/^\[(.+)\]$/, ":$1"))].join("/");
        const src = readFileSync(full, "utf8");
        for (const m of METHODS) {
          if (new RegExp(`export\\s+(const|async\\s+function|function)\\s+${m}\\b`).test(src)) {
            out.push({ method: m, path, file: relative(ADMIN_X_DIR, full) });
          }
        }
      }
    }
  };
  walk(ADMIN_X_DIR);
  return out;
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    const accounts = {} as Record<Role, MfaAdmin>;
    let noRole: AdminAccount;

    // Tạo trong beforeAll → nằm trong bản chụp DB mà runner khôi phục trước mỗi test.
    beforeAll(async () => {
      container = getContainer();
      for (const role of ROLES) accounts[role] = await createMfaAdmin(rawApi, container, { roles: [role] });
      noRole = await createAdmin(rawApi, container, { roles: [] });
    });

    const call = (method: string, url: string, headers: Record<string, string>, data: unknown = {}) =>
      api.request({ method, url, headers, ...(method === "GET" ? {} : { data }), ...noThrow });

    const concrete = (route: AdminXRoute) =>
      route.path.replace(/:id\b/g, accounts.warehouse.userId).replace(/:(\w+)/g, "khong-co-$1");

    describe("map quyền /admin/x/* × 6 vai trò (sinh tự động từ ADMIN_X_PERMISSIONS)", () => {
      it.each(
        ADMIN_X_PERMISSIONS.map(
          (r) => [`${r.method} ${r.path} → ${requiredPermissions(r).join(" + ")}`, r] as const,
        ),
      )("%s", async (_name, route) => {
        for (const role of ROLES) {
          const res = await call(route.method, concrete(route), accounts[role].headers);
          const allowed = requiredPermissions(route).every((p) => can([role], p));
          if (allowed) {
            expect({ role, status: res.status }).not.toEqual({ role, status: 403 });
          } else {
            expect({ role, status: res.status, code: res.data.code }).toEqual({
              role,
              status: 403,
              code: "FORBIDDEN",
            });
            expect(res.headers["content-type"]).toContain("application/problem+json");
          }
        }
        // User chưa có vai trò nào: không có quyền gì ở /admin/x.
        const none = await call(route.method, concrete(route), noRole.headers);
        expect(none.status).toBe(403);
      });
    });

    describe("AT21 + fail-closed", () => {
      it("AT21: warehouse gọi thẳng POST /admin/x/refunds → 403 problem+json, audit ghi lần bị từ chối", async () => {
        const res = await call("POST", "/admin/x/refunds", accounts.warehouse.headers, { amount: 100_000 });
        expect(res.status).toBe(403);
        expect(res.headers["content-type"]).toContain("application/problem+json");
        expect(res.data).toMatchObject({ code: "FORBIDDEN", status: 403, permission: "refund.request" });

        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { action: "rbac.denied", actor_id: accounts.warehouse.userId },
          { limit: 10, offset: 0 },
        );
        expect(entries[0]).toMatchObject({
          actor_type: "user",
          resource_type: "route",
          resource_id: "POST /admin/x/refunds",
          changes: { permission: "refund.request", roles: ["warehouse"], reason: "missing_permission" },
        });
        expect(entries[0]?.ip_hash).toMatch(/^[0-9a-f]{32}$/);

        // Kế toán (refund.request + MFA) qua được RBAC → tới handler (T-027): thiếu Idempotency-Key/dữ liệu → 422.
        const ok = await call("POST", "/admin/x/refunds", accounts.accountant.headers, {});
        expect(ok.status).toBe(422);
        // Kho cũng không duyệt/thực hiện được hoàn tiền (refund.approve / refund.execute).
        for (const action of ["approve", "execute"]) {
          const denied = await call(
            "POST",
            `/admin/x/refunds/khong-co/${action}`,
            accounts.warehouse.headers,
          );
          expect(denied.status).toBe(403);
        }
      });

      it("đổi hoa/thường hay thêm '/' cuối không lách được quyền (Express không phân biệt hoa thường)", async () => {
        for (const url of ["/ADMIN/X/REFUNDS", "/admin/x/Refunds/", "/admin//x/refunds"]) {
          const res = await call("POST", url, accounts.warehouse.headers);
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
        }
      });

      it("route /admin/x không khai báo trong map → 403 kể cả owner; chưa đăng nhập → 401", async () => {
        expect((await call("GET", "/admin/x/khong-khai-bao", accounts.owner.headers)).status).toBe(403);
        expect((await call("DELETE", "/admin/x/size-charts", accounts.owner.headers)).status).toBe(403);
        const anon = await call("GET", "/admin/x/size-charts", {});
        expect(anon.status).toBe(401);
      });

      it("mọi file route dưới src/api/admin/x/ có mục trong map, và mọi mục trong map có route thật", () => {
        const files = scanRouteFiles();
        expect(files.length).toBeGreaterThan(0);
        const missing = files.filter(
          (f) => !ADMIN_X_PERMISSIONS.some((r) => r.method === f.method && r.path === f.path),
        );
        expect(missing).toEqual([]);
        const stale = ADMIN_X_PERMISSIONS.filter(
          (r) => !files.some((f) => f.method === r.method && f.path === r.path),
        );
        expect(stale).toEqual([]);
        // Mỗi (method, path) khai báo đúng một lần.
        const keys = ADMIN_X_PERMISSIONS.map((r) => `${r.method} ${r.path}`);
        expect(new Set(keys).size).toBe(keys.length);
      });
    });

    describe("route admin native nhạy cảm", () => {
      const SAMPLES: [string, string][] = [
        ["POST", "/admin/payments/pay_khong_co/refund"],
        ["POST", "/admin/payments/pay_khong_co/capture"],
        ["POST", "/admin/orders/order_khong_co/cancel"],
        ["POST", "/admin/orders/order_khong_co/fulfillments"],
        ["POST", "/admin/users/user_khong_co"],
        ["GET", "/admin/users"],
        ["POST", "/admin/invites"],
        ["GET", "/admin/api-keys"],
        ["POST", "/admin/stores/store_khong_co"],
        ["POST", "/admin/inventory-items/iitem_khong_co/location-levels"],
        ["POST", "/admin/products"],
        ["GET", "/admin/customers"],
        ["GET", "/admin/orders"],
        ["GET", "/admin/products"],
        ["POST", "/admin/regions"],
      ];

      it.each(SAMPLES)("%s %s: 403 đúng theo ma trận × 6 vai trò", async (method, url) => {
        const rule = resolveAdminRule(method, url.toLowerCase());
        for (const role of ROLES) {
          const res = await call(method, url, accounts[role].headers);
          const allowed =
            rule.kind === "any_role" || (rule.kind === "permission" && can([role], rule.permission));
          if (allowed) expect({ role, status: res.status }).not.toEqual({ role, status: 403 });
          else
            expect({ role, status: res.status, code: res.data.code }).toEqual({
              role,
              status: 403,
              code: "FORBIDDEN",
            });
        }
        expect((await call(method, url, noRole.headers)).status).toBe(403);
      });

      it("kho không hoàn tiền/hủy đơn native; user chưa có vai trò chỉ đọc hồ sơ mình", async () => {
        expect((await call("POST", "/admin/payments/x/refund", accounts.warehouse.headers)).status).toBe(403);
        expect((await call("POST", "/admin/orders/x/cancel", accounts.warehouse.headers)).status).toBe(403);
        const me = await call("GET", "/admin/users/me", noRole.headers);
        expect(me.status).toBe(200);
        expect((me.data.user as { id: string }).id).toBe(noRole.userId);
        expect((await call("GET", "/admin/stores", noRole.headers)).status).toBe(403);
      });

      it("bảng native: mọi mẫu path hợp lệ, không trùng (method, path)", () => {
        const keys = NATIVE_ADMIN_ROUTES.map((r) => `${r.methods.join(",")} ${r.path}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const r of NATIVE_ADMIN_ROUTES) expect(r.path.startsWith("/admin/")).toBe(true);
      });

      it("khoá API bí mật (actor api-key, không có vai trò) bị từ chối ở route nhạy cảm và /admin/x", async () => {
        const key = await container
          .resolve(Modules.API_KEY)
          .createApiKeys({ title: "rbac-test", type: "secret", created_by: accounts.owner.userId });
        const basic = { authorization: `Basic ${Buffer.from(`${key.token}:`).toString("base64")}` };
        expect((await call("GET", "/admin/x/size-charts", basic)).status).toBe(403);
        expect((await call("POST", "/admin/api-keys", basic, { title: "x", type: "secret" })).status).toBe(
          403,
        );
      });
    });

    describe("quản lý vai trò", () => {
      it("owner (MFA) cấp/thu hồi vai trò; ghi audit trước/sau; vai trò lạ 422; user lạ 404", async () => {
        const target = await createAdmin(rawApi, container, { roles: [] });
        const url = `/admin/x/users/${target.userId}/roles`;
        const h = accounts.owner.headers;

        expect((await call("GET", "/admin/products", target.headers)).status).toBe(403);
        const granted = await call("POST", url, h, { role: "catalog_manager", reason: "nhân sự mới" });
        expect(granted.status).toBe(201);
        expect(granted.data.roles).toEqual(["catalog_manager"]);
        // Có hiệu lực ngay (không cache vai trò).
        expect((await call("GET", "/admin/products", target.headers)).status).toBe(200);
        expect((await call("POST", url, h, { role: "catalog_manager" })).status).toBe(200);
        expect((await call("POST", url, h, { role: "superuser" })).status).toBe(422);
        expect(
          (await call("POST", "/admin/x/users/user_khong_co/roles", h, { role: "support" })).status,
        ).toBe(404);

        const list = await call("GET", url, h);
        expect(list.data.roles).toEqual([
          expect.objectContaining({ role: "catalog_manager", granted_by: accounts.owner.userId }),
        ]);

        const revoked = await call("DELETE", `${url}?role=catalog_manager`, h);
        expect(revoked).toMatchObject({ status: 200, data: { roles: [], changed: true } });
        expect((await call("GET", "/admin/products", target.headers)).status).toBe(403);

        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { resource_type: "user", resource_id: target.userId },
          { limit: 10, offset: 0 },
        );
        expect(entries.map((e) => e.action)).toEqual(["rbac.role_revoked", "rbac.role_granted"]);
        expect(entries[1]).toMatchObject({
          actor_id: accounts.owner.userId,
          reason: "nhân sự mới",
          changes: { role: "catalog_manager", before: [], after: ["catalog_manager"] },
        });
      });

      it("đồng thời: cấp cùng vai trò 5 lần song song → đúng 1 lần tạo + 1 dòng audit", async () => {
        const target = await createAdmin(rawApi, container, { roles: [] });
        const url = `/admin/x/users/${target.userId}/roles`;
        const results = await Promise.all(
          Array.from({ length: 5 }, () => call("POST", url, accounts.owner.headers, { role: "support" })),
        );
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { count } = await audit.list(
          { action: "rbac.role_granted", resource_id: target.userId },
          { limit: 10, offset: 0 },
        );
        expect(count).toBe(1);
      });

      it("đồng thời: thu hồi hai owner cuối song song → đúng một thành công, owner cuối được giữ (LAST_OWNER)", async () => {
        const rbac = container.resolve<RbacModuleService>(RBAC_MODULE);
        const other = await createAdmin(rawApi, container, { roles: ["owner"] });
        const results = await Promise.all([
          rbac.revoke(accounts.owner.userId, "owner"),
          rbac.revoke(other.userId, "owner"),
        ]);
        expect(results.filter((r) => r.removed)).toHaveLength(1);
        expect(results.filter((r) => r.lastOwner)).toHaveLength(1);
        const owners = (
          await Promise.all([rbac.rolesOf(accounts.owner.userId), rbac.rolesOf(other.userId)])
        ).filter((r) => r.includes("owner"));
        expect(owners).toHaveLength(1);
      });

      it("qua HTTP: thu hồi owner cuối cùng → 409 LAST_OWNER", async () => {
        const res = await call(
          "DELETE",
          `/admin/x/users/${accounts.owner.userId}/roles`,
          accounts.owner.headers,
          { role: "owner" },
        );
        expect(res).toMatchObject({ status: 409, data: { code: "LAST_OWNER" } });
      });

      it("vai trò khác owner không quản lý được vai trò (kể cả tự nâng quyền)", async () => {
        for (const role of ROLES.filter((r) => r !== "owner")) {
          const self = `/admin/x/users/${accounts[role].userId}/roles`;
          const res = await call("POST", self, accounts[role].headers, { role: "owner" });
          expect({ role, status: res.status }).toEqual({ role, status: 403 });
        }
      });

      it("script grant-owner: cấp owner theo email (idempotent), email lạ → lỗi", async () => {
        const target = await createAdmin(rawApi, container, { roles: [] });
        const first = await grantOwner({ container, args: [target.email.toUpperCase()] });
        expect(first).toEqual({ userId: target.userId, created: true });
        expect((await grantOwner({ container, args: [target.email] })).created).toBe(false);
        expect(await container.resolve<RbacModuleService>(RBAC_MODULE).rolesOf(target.userId)).toEqual([
          "owner",
        ]);
        await expect(grantOwner({ container, args: ["khong-co@x-shop.test"] })).rejects.toThrow();
        await expect(grantOwner({ container, args: [] })).rejects.toThrow();
      });
    });
  },
});
