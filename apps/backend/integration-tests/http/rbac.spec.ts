import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { dirname, join, relative, sep } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { can, ROLES, type Role } from "@x-shop/domain";
import {
  ADMIN_X_PERMISSIONS,
  requiredPermissions,
  type AdminXRoute,
} from "../../src/api/admin/x/permissions";
import { forbiddenFields, nativeReadFieldPolicy } from "../../src/lib/admin-security/field-policy";
import { NATIVE_ADMIN_ROUTES } from "../../src/lib/admin-security/native-permissions";
import { resolveAdminRule } from "../../src/lib/admin-security/policy";
import { installAccessLogServerHook, type HttpModuleLike } from "../../src/lib/log/http";
import { createLogger } from "../../src/lib/log/logger";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { RBAC_MODULE } from "../../src/modules/rbac";
import type RbacModuleService from "../../src/modules/rbac/service";
import grantOwner from "../../src/scripts/grant-owner";
import { createAdmin, createMfaAdmin, noThrow, type AdminAccount, type MfaAdmin } from "../helpers/auth";
import { createPromotion } from "../helpers/checkout-fixtures";

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

/** Cây route GET admin native của Medusa đang cài (`@medusajs/medusa/dist/api/admin/**\/route.js`) — T-147. */
function coreNativeGetRoutes(): string[] {
  const root = join(dirname(require.resolve("@medusajs/medusa/package.json")), "dist/api/admin");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.js" && /\bexports\.GET\s*=/.test(readFileSync(full, "utf8"))) {
        const rel = relative(root, dir).split(sep).filter(Boolean);
        out.push(["/admin", ...rel.map((s) => s.replace(/^\[(.+)\]$/, ":$1"))].join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Lời gọi admin của dashboard Medusa đang cài (T-147): tên `sdk.admin.<tài nguyên>.<hàm>` trong bundle
 * `@medusajs/dashboard/dist`, ánh xạ sang `METHOD /admin/...` theo mã `@medusajs/js-sdk/dist/esm/admin` mà dashboard phụ
 * thuộc (`:p` = tham số đường dẫn). `unmapped` ≠ [] = định dạng js-sdk đổi — test đỏ thay vì bỏ sót im lặng.
 */
function dashboardNativeCalls(): {
  used: number;
  calls: Map<string, string>;
  unmapped: string[];
  bundles: Record<string, number>;
} {
  const dash = dirname(require.resolve("@medusajs/dashboard/package.json"));
  // Bundle admin: dashboard lõi + plugin admin đã cài (`@medusajs/draft-order` — màn đơn nháp).
  const bundleDirs: Record<string, string> = {
    "@medusajs/dashboard": join(dash, "dist"),
    "@medusajs/draft-order": join(
      dirname(require.resolve("@medusajs/draft-order/package.json")),
      ".medusa/server/src/admin",
    ),
  };
  const used = new Set<string>();
  const bundles: Record<string, number> = {};
  for (const [name, dir] of Object.entries(bundleDirs)) {
    const before = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => /\.m?js$/.test(n)))
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/sdk\.admin\.(\w+)\.(\w+)/g)) {
        before.add(`${m[1]}.${m[2]}`);
        used.add(`${m[1]}.${m[2]}`);
      }
    bundles[name] = before.size;
  }
  const sdkAdmin = join(dirname(require.resolve("@medusajs/js-sdk", { paths: [dash] })), "esm/admin");
  const index = readFileSync(join(sdkAdmin, "index.js"), "utf8");
  const propOf = new Map([...index.matchAll(/this\.(\w+) = new (\w+)\(/g)].map((m) => [m[2]!, m[1]!]));
  const calls = new Map<string, string>();
  for (const f of readdirSync(sdkAdmin).filter((n) => n.endsWith(".js") && n !== "index.js")) {
    const src = readFileSync(join(sdkAdmin, f), "utf8");
    const prop = propOf.get(/^(?:export (?:default )?)?class (\w+)/m.exec(src)?.[1] ?? "");
    if (!prop) continue;
    const consts = new Map([...src.matchAll(/const (\w+) = "(\/admin[^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    for (const m of src.matchAll(/\n {4}(\w+)\([^)]*\) \{([\s\S]*?)\n {4}\}/g)) {
      const key = `${prop}.${m[1]}`;
      if (!used.has(key)) continue;
      const call = /this\.client\.fetch\(\s*(`[^`]*`|"[^"]*"|\w+)\s*(,\s*\{([^}]*)\})?/.exec(m[2]!);
      if (!call) continue;
      const first = call[1]!;
      const raw = /^\w+$/.test(first) ? (consts.get(first) ?? first) : first.slice(1, -1);
      const path = raw
        .replace(/\$\{(\w+)\}/g, (s, v: string) => consts.get(v) ?? s)
        .replace(/\$\{[^}]+\}/g, ":p");
      calls.set(key, `${/method:\s*"(\w+)"/.exec(call[3] ?? "")?.[1] ?? "GET"} ${path}`);
    }
  }
  return { used: used.size, calls, unmapped: [...used].filter((k) => !calls.has(k)).sort(), bundles };
}

/** Thực thể chứa/dẫn tới PII khách, tiền, nhân sự — alias quan hệ tới chúng phải bị field-policy.ts chặn. */
const SENSITIVE_ENTITIES = new Set([
  "Order",
  "Cart",
  "Customer",
  "Fulfillment",
  "PaymentCollection",
  "Payment",
  "AccountHolder",
  "OrderLineItem",
  "LineItem",
  "Return",
  "User",
  "Invite",
]);

interface LinkRel {
  serviceName?: string;
  entity?: string;
  alias: string;
}
interface LinkDef {
  isLink?: boolean;
  serviceName?: string;
  relationships?: LinkRel[];
  extends?: {
    serviceName: string;
    entity?: string;
    relationship: LinkRel;
    fieldAlias?: Record<string, string | { path: string }>;
  }[];
}

/**
 * Alias quan hệ do link của Medusa thêm vào thực thể (`@medusajs/link-modules/dist/definitions` + `readonly`) mà dẫn tới
 * thực thể nhạy cảm: alias quan hệ trực tiếp, và field alias có đoạn cuối là alias nhạy cảm của bảng nối
 * (`Order.cart => cart_link.cart`). Trả `Thực thể.alias → Đích`.
 */
function sensitiveLinkAliases(): string[] {
  const medusa = dirname(require.resolve("@medusajs/medusa/package.json"));
  const dist = dirname(require.resolve("@medusajs/link-modules", { paths: [medusa] }));
  // Nạp đúng bản link-modules mà @medusajs/medusa đang dùng (không phải phụ thuộc trực tiếp của backend).
  const load = createRequire(join(dist, "index.js"));
  const defs = [
    ...Object.values(load("./definitions/index.js") as Record<string, LinkDef>),
    ...Object.values(load("./definitions/readonly/index.js") as Record<string, LinkDef>),
  ].filter((d) => d?.isLink);
  const target = (r: LinkRel) => r.entity ?? r.serviceName ?? "";
  // Alias trong bảng nối → các thực thể đích (một alias như `order` xuất hiện ở nhiều link).
  const joinAliasTargets = new Map<string, Set<string>>();
  for (const d of defs)
    for (const r of d.relationships ?? [])
      joinAliasTargets.set(r.alias, new Set([...(joinAliasTargets.get(r.alias) ?? []), target(r)]));
  const out = new Set<string>();
  for (const d of defs) {
    for (const r of d.relationships ?? [])
      if (SENSITIVE_ENTITIES.has(target(r))) out.add(`${d.serviceName}.${r.alias} → ${target(r)}`);
    for (const e of d.extends ?? []) {
      const from = e.entity ?? e.serviceName;
      if (SENSITIVE_ENTITIES.has(target(e.relationship)))
        out.add(`${from}.${e.relationship.alias} → ${target(e.relationship)}`);
      for (const [alias, def] of Object.entries(e.fieldAlias ?? {})) {
        const last = (typeof def === "string" ? def : def.path).split(".").pop() ?? "";
        for (const t of joinAliasTargets.get(last) ?? [])
          if (SENSITIVE_ENTITIES.has(t)) out.add(`${from}.${alias} → ${t}`);
      }
    }
  }
  return [...out].sort();
}

/**
 * Route sau cờ tính năng (tắt ở dự án → không đăng ký, test HTTP không chạm tới): chốt quy tắc để đổi quyền là đỏ.
 */
const FLAGGED_ROUTE_RULES: Record<string, ReturnType<typeof resolveAdminRule>> = {
  "/admin/translations": { kind: "permission", permission: "catalog.read", also: [], reauth: false },
  "/admin/property-labels": { kind: "permission", permission: "catalog.read", also: [], reauth: false },
  "/admin/locales": { kind: "any_role" },
  "/admin/views": { kind: "any_role" },
  "/admin/layouts": { kind: "any_role" },
  "/admin/rbac": { kind: "permission", permission: "settings.manage", also: [], reauth: false },
};

/**
 * Route GET native Medusa CỐ Ý để đóng mặc định (403 với mọi vai trò, kể cả owner) — dashboard 2.22.1 không gọi; mỗi mục
 * có lý do. Route GET native mới (nâng cấp Medusa) chưa khai và không có ở đây → test đỏ, buộc phân loại.
 */
const UNDECLARED_BY_DESIGN: Record<string, string> = {
  "/admin/index/details": "chẩn đoán Index Module (cờ index_engine), dashboard không dùng",
  "/admin/uploads/:id":
    "dashboard chỉ upload (POST); file private chỉ tải qua GET /admin/x/files/:key (T-141)",
  "/admin/fulfillment-sets/:id/service-zones/:zone_id": "dashboard đọc vùng giao qua stock-locations",
};

/** Tổng số route GET admin native của `@medusajs/medusa` 2.22.1 đã rà và phân loại (T-147, D-108). */
const NATIVE_GET_ROUTE_COUNT = 133;

/** Mẫu Express → path cụ thể để tra quy tắc (mọi tham số = `x1`). */
const concretePath = (pattern: string) => pattern.replace(/:\w+/g, "x1").toLowerCase();

/**
 * T-145: cài hook server của `medusa start` (instrumentation.ts) lên `http.createServer` TRƯỚC khi runner dựng app — server
 * test chạy đúng lớp chặn request-target như production. Gỡ ở afterAll (module `node:http` dùng chung giữa các file test).
 */
const httpModule = http as unknown as HttpModuleLike;
const originalCreateServer = httpModule.createServer;
const accessLog: string[] = [];
installAccessLogServerHook(
  createLogger({ service: "test", version: "0", env: "test", write: (l) => accessLog.push(l) }),
  httpModule,
);
afterAll(() => {
  httpModule.createServer = originalCreateServer;
});

/** Gửi request-target THÔ qua socket (axios/http.request luôn gửi origin-form). Đọc tới khi server đóng kết nối. */
function rawRequest(port: number, target: string, headers: Record<string, string>) {
  return new Promise<{ status: number; text: string; json: Record<string, unknown> }>((resolve, reject) => {
    const head = Object.entries({ host: `localhost:${port}`, ...headers, connection: "close" })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    const socket = net.connect(port, "127.0.0.1", () =>
      socket.write(`GET ${target} HTTP/1.1\r\n${head}\r\n\r\n`),
    );
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text.slice(text.indexOf("\r\n\r\n") + 4);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // thân không phải JSON (chunked/HTML) — test dựa vào `text`
      }
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text, json });
    });
  });
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

    describe("[api5-bfla admin:*] map quyền /admin/x/* × 6 vai trò (sinh tự động từ ADMIN_X_PERMISSIONS)", () => {
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
      it("[api5-bfla post /admin/x/refunds] AT21: warehouse gọi thẳng POST /admin/x/refunds → 403 problem+json, audit ghi lần bị từ chối", async () => {
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

    describe("T-147: đọc native đóng mặc định — liệt kê theo màn hình dashboard, PII chỉ cho vai trò cần", () => {
      const UNDECLARED = { kind: "deny", reason: "UNDECLARED_ROUTE" } as const;

      it("mọi route GET dashboard Medusa gọi (bundle + js-sdk) đều có trong cây route và đã khai trong bảng native", () => {
        const { used, calls, unmapped, bundles } = dashboardNativeCalls();
        expect(unmapped).toEqual([]);
        expect(used).toBeGreaterThanOrEqual(300);
        // Cả hai bundle đều được quét (plugin đơn nháp gọi sdk.admin.draftOrder.*, customer.*, user.retrieve…).
        expect(bundles["@medusajs/dashboard"]).toBeGreaterThanOrEqual(300);
        expect(bundles["@medusajs/draft-order"]).toBeGreaterThanOrEqual(20);
        expect(calls.get("draftOrder.list")).toBe("GET /admin/draft-orders");
        const gets = [...new Set([...calls.values()].filter((c) => c.startsWith("GET ")))].map((c) =>
          c.slice(4),
        );
        expect(gets.length).toBeGreaterThanOrEqual(100);
        const core = coreNativeGetRoutes();
        const asRegex = (pattern: string) => new RegExp(`^${pattern.replace(/:\w+/g, "[^/]+")}$`);
        const problems: string[] = [];
        for (const path of gets) {
          const concrete = concretePath(path);
          if (!core.some((c) => asRegex(c.toLowerCase()).test(concrete)))
            problems.push(`${path}: không có route`);
          const rule = resolveAdminRule("GET", concrete);
          if (rule.kind === "deny") problems.push(`${path}: ${rule.reason}`);
        }
        expect(problems).toEqual([]);
      });

      it("mọi route GET native của Medusa: đã khai, hoặc cố ý đóng (UNDECLARED_BY_DESIGN có lý do); không mục thừa", () => {
        const core = coreNativeGetRoutes();
        expect(core.length).toBeGreaterThanOrEqual(100);
        const undeclared = core.filter((path) => {
          const rule = resolveAdminRule("GET", concretePath(path));
          return rule.kind === UNDECLARED.kind && rule.reason === UNDECLARED.reason;
        });
        expect(undeclared).toEqual(Object.keys(UNDECLARED_BY_DESIGN).sort());
      });

      it("chốt tổng số route GET native của Medusa (D-108): đổi khi nâng cấp → rà lại native-permissions.ts", () => {
        const core = coreNativeGetRoutes();
        // Route GET mới nằm TRONG một họ đã khai (vd. `/admin/products/*`) tự nhận quy tắc của họ — test trên không bắt
        // được; chốt số lượng buộc rà từng route mới/bị bỏ trước khi cập nhật số này.
        const message =
          `Medusa có ${core.length} route GET admin native (đã chốt ${NATIVE_GET_ROUTE_COUNT}). Rà lại ` +
          "apps/backend/src/lib/admin-security/native-permissions.ts cho từng route thêm/bớt (PII → chỉ vai trò cần), " +
          "cập nhật bảng ở docs/specs/SPEC-admin.md rồi mới đổi NATIVE_GET_ROUTE_COUNT.";
        expect({ count: core.length, message }).toEqual({ count: NATIVE_GET_ROUTE_COUNT, message });
      });

      it("route sau cờ tính năng (translations, property-labels, locales, views, layouts, rbac): quy tắc đã chốt", () => {
        const core = coreNativeGetRoutes();
        const problems: string[] = [];
        for (const [family, expected] of Object.entries(FLAGGED_ROUTE_RULES)) {
          const routes = core.filter((r) => r === family || r.startsWith(`${family}/`));
          if (routes.length === 0) problems.push(`${family}: không còn route trong Medusa`);
          for (const r of routes) {
            const actual = resolveAdminRule("GET", concretePath(r));
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              problems.push(`${r}: ${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
          }
        }
        expect(problems).toEqual([]);
      });

      it("link Medusa: mọi alias dẫn tới đơn/giỏ/khách/vận đơn/thanh toán/người dùng nằm trong danh sách cấm fields", () => {
        const aliases = sensitiveLinkAliases();
        // Ca đã biết phải có trong kết quả quét (chống quét rỗng khi định dạng link đổi).
        expect(aliases).toEqual(
          expect.arrayContaining([
            "Region.orders → Order",
            "SalesChannel.orders → Order",
            "Customer.orders → Order",
            "ProductVariant.order_items → OrderLineItem",
            "PaymentCollection.order → Order",
            "OrderOrderPromotionPromotionLink.order → Order",
          ]),
        );
        const policy = nativeReadFieldPolicy("/admin/regions", ["support"])!;
        const notBlocked = aliases.filter((a) => {
          const alias = a.split(" → ")[0]!.split(".").pop()!;
          return forbiddenFields([alias], policy).length === 0;
        });
        expect(notBlocked).toEqual([]);
        // Bảng nối (`order_link`, `payment_collection_link`, …) chặn theo họ `*_link`.
        expect(forbiddenFields(["order_link", "promotion_link", "x_link"], policy)).toHaveLength(3);
      });

      it("không route admin native nào của Medusa tự đặt `disallowed` (cổng gán req.disallowed đè lên)", () => {
        const root = join(dirname(require.resolve("@medusajs/medusa/package.json")), "dist/api/admin");
        const offenders: string[] = [];
        const walk = (dir: string) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".js") && /\bdisallowed\b/.test(readFileSync(full, "utf8")))
              offenders.push(relative(root, full));
          }
        };
        walk(root);
        expect(offenders).toEqual([]);
      });

      /**
       * Màn hình dashboard → route đọc (nguồn: hook `src/hooks/api/*` mà `src/routes/<màn>` của @medusajs/dashboard 2.22.1
       * dùng) → vai trò được đọc. Vai trò khác → 403. Route có cờ tính năng tắt (locales, translations, property-labels, views,
       * rbac) không đăng ký (404) nên chỉ kiểm tĩnh ở hai test trên.
       */
      const SCREENS: { screen: string; urls: string[]; roles: Role[] }[] = [
        {
          screen:
            "khung dashboard + bộ lọc (header cửa hàng, vùng, kênh bán, tiền tệ, plugin, lý do đổi trả/hoàn)",
          urls: [
            "/admin/stores",
            "/admin/regions",
            "/admin/sales-channels",
            "/admin/currencies",
            "/admin/plugins",
            "/admin/return-reasons",
            "/admin/refund-reasons",
          ],
          roles: [...ROLES],
        },
        {
          screen:
            "catalog (sản phẩm, biến thể, danh mục, bộ sưu tập, tag, loại, tuỳ chọn, hồ sơ giao, giá gồm thuế)",
          urls: [
            "/admin/products",
            "/admin/product-variants",
            "/admin/product-categories",
            "/admin/collections",
            "/admin/product-tags",
            "/admin/product-types",
            "/admin/product-options",
            "/admin/shipping-profiles",
            "/admin/price-preferences",
          ],
          roles: ["owner", "catalog_manager", "warehouse"],
        },
        {
          screen: "bảng giá / khuyến mãi / chiến dịch",
          urls: ["/admin/price-lists", "/admin/promotions", "/admin/campaigns"],
          roles: ["owner", "catalog_manager"],
        },
        {
          screen: "kho (tồn, giữ hàng, kho hàng)",
          urls: ["/admin/inventory-items", "/admin/reservations", "/admin/stock-locations"],
          roles: ["owner", "catalog_manager", "order_staff", "warehouse"],
        },
        {
          screen: "đơn hàng (đơn, đổi trả, khiếu nại, đổi hàng, đơn nháp) — PII",
          urls: [
            "/admin/orders",
            "/admin/returns",
            "/admin/claims",
            "/admin/exchanges",
            "/admin/draft-orders",
          ],
          roles: ["owner", "order_staff", "accountant"],
        },
        {
          screen: "khách hàng (danh sách, nhóm) — PII",
          urls: ["/admin/customers", "/admin/customer-groups"],
          roles: ["owner", "order_staff", "accountant"],
        },
        {
          screen: "form tạo vận đơn (phương án giao)",
          urls: ["/admin/shipping-options"],
          roles: ["owner", "order_staff"],
        },
        {
          screen: "thanh toán",
          urls: ["/admin/payments", "/admin/payments/payment-providers"],
          roles: ["owner", "accountant"],
        },
        {
          screen: "người dùng / lời mời — PII nhân sự",
          urls: ["/admin/users", "/admin/invites"],
          roles: ["owner"],
        },
        {
          screen: "cài đặt chỉ owner (khoá API, thông báo, tìm kiếm toàn cục, thuế, vận chuyển, workflow)",
          urls: [
            "/admin/api-keys",
            "/admin/notifications",
            "/admin/search?q=a",
            "/admin/search-indexes",
            "/admin/tax-regions",
            "/admin/tax-rates",
            "/admin/tax-providers",
            "/admin/fulfillment-providers",
            "/admin/shipping-option-types",
            "/admin/workflows-executions",
          ],
          roles: ["owner"],
        },
      ];

      it.each(SCREENS.map((s) => [s.screen, s] as const))(
        "màn %s: vai trò cần → 200, vai trò khác → 403",
        async (_name, { urls, roles }) => {
          const actual: { url: string; role: string; status: number }[] = [];
          const expected: typeof actual = [];
          for (const url of urls) {
            for (const role of ROLES) {
              const res = await call("GET", url, accounts[role].headers);
              actual.push({ url, role, status: res.status });
              expected.push({ url, role, status: roles.includes(role) ? 200 : 403 });
            }
            actual.push({
              url,
              role: "(không vai trò)",
              status: (await call("GET", url, noRole.headers)).status,
            });
            expected.push({ url, role: "(không vai trò)", status: 403 });
          }
          expect(actual).toEqual(expected);
        },
      );

      it("PII thật: CSKH/kho/catalog bị chặn ở khách, địa chỉ, đơn, người dùng, tìm kiếm toàn cục — không lộ email/SĐT", async () => {
        const EMAIL = "khach-t147@example.test";
        const PHONE = "0987654321";
        const [customer] = await container.resolve(Modules.CUSTOMER).createCustomers([
          {
            email: EMAIL,
            phone: PHONE,
            first_name: "Khach",
            last_name: "T147",
            addresses: [{ phone: PHONE }],
          },
        ]);
        const id = customer!.id;
        const pii = [
          `/admin/customers/${id}`,
          `/admin/customers/${id}/addresses`,
          `/admin/customers?q=${encodeURIComponent(EMAIL)}`,
          `/admin/search?q=${encodeURIComponent(EMAIL)}`,
          `/admin/users/${accounts.owner.userId}`,
          "/admin/users",
          "/admin/notifications",
        ];
        const leaks = (data: unknown) => {
          const text = JSON.stringify(data);
          return text.includes(EMAIL) || text.includes(PHONE) || text.includes(accounts.owner.email);
        };
        for (const role of ["support", "warehouse", "catalog_manager"] as const) {
          for (const url of pii) {
            const res = await call("GET", url, accounts[role].headers);
            expect({ role, url, status: res.status, code: res.data.code, leak: leaks(res.data) }).toEqual({
              role,
              url,
              status: 403,
              code: "FORBIDDEN",
              leak: false,
            });
          }
        }
        // Vai trò cần (đơn/kế toán) đọc được hồ sơ khách; người dùng/tìm kiếm toàn cục chỉ owner.
        for (const role of ["order_staff", "accountant", "owner"] as const) {
          const res = await call("GET", `/admin/customers/${id}?fields=*addresses`, accounts[role].headers);
          expect({ role, status: res.status }).toEqual({ role, status: 200 });
          expect((res.data.customer as { email: string }).email).toBe(EMAIL);
        }
        for (const role of ["order_staff", "accountant"] as const) {
          for (const url of [`/admin/users/${accounts.owner.userId}`, `/admin/search?q=${EMAIL}`]) {
            expect({ role, url, status: (await call("GET", url, accounts[role].headers)).status }).toEqual({
              role,
              url,
              status: 403,
            });
          }
        }
        const search = await call(
          "GET",
          `/admin/search?q=${encodeURIComponent(EMAIL)}`,
          accounts.owner.headers,
        );
        expect(search.status).toBe(200);
      });

      it("form tạo vận đơn native: nhân viên đơn đọc được biến thể kèm tồn; CSKH/kế toán không; catalog đọc qua catalog.read", async () => {
        const [product] = await container.resolve(Modules.PRODUCT).createProducts([
          {
            title: "Áo T-147",
            options: [{ title: "Size", values: ["M"] }],
            variants: [{ title: "M", sku: "T147-M", options: { Size: "M" } }],
          },
        ]);
        const variantId = product!.variants[0]!.id;
        const detail = `/admin/products/${product!.id}/variants/${variantId}?fields=*inventory_items`;
        const list = `/admin/products/${product!.id}/variants`;
        const status = async (url: string, role: Role) =>
          (await call("GET", url, accounts[role].headers)).status;
        const actual = await Promise.all(
          ROLES.map(async (role) => ({
            role,
            detail: await status(detail, role),
            list: await status(list, role),
          })),
        );
        expect(actual).toEqual(
          ROLES.map((role) => ({
            role,
            detail: ["owner", "catalog_manager", "order_staff", "warehouse"].includes(role) ? 200 : 403,
            list: ["owner", "catalog_manager", "warehouse"].includes(role) ? 200 : 403,
          })),
        );
      });

      it("GET/HEAD native chưa khai → 403 FORBIDDEN với MỌI vai trò, kể cả owner; audit lý do UNDECLARED_ROUTE", async () => {
        const urls = [
          "/admin/khong-khai-bao",
          "/admin/route-doc-moi/abc",
          "/admin/index/details",
          "/admin/uploads/file_khong_co",
          "/admin/fulfillment-sets/fs_1/service-zones/sz_1",
        ];
        for (const url of urls) {
          for (const role of ROLES) {
            const res = await call("GET", url, accounts[role].headers);
            expect({ url, role, status: res.status, code: res.data.code }).toEqual({
              url,
              role,
              status: 403,
              code: "FORBIDDEN",
            });
          }
          const head = await api.request({
            method: "HEAD",
            url,
            headers: accounts.owner.headers,
            ...noThrow,
          });
          expect({ url, head: head.status }).toEqual({ url, head: 403 });
        }
        expect((await call("GET", "/admin/khong-khai-bao", {})).status).toBe(401);
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { action: "rbac.denied", actor_id: accounts.owner.userId },
          { limit: 20, offset: 0 },
        );
        expect(entries.map((e) => e.resource_id)).toContain("GET /admin/khong-khai-bao");
        expect(entries.find((e) => e.resource_id === "GET /admin/khong-khai-bao")?.changes).toMatchObject({
          reason: "UNDECLARED_ROUTE",
          roles: ["owner"],
        });
      });

      it("đồng thời: 48 request song song trộn 6 vai trò × route PII/catalog/chưa khai → mỗi request đúng quyền", async () => {
        const cases: { role: Role; url: string; expected: number }[] = [];
        for (const role of ROLES) {
          cases.push({
            role,
            url: "/admin/customers",
            expected: ["owner", "order_staff", "accountant"].includes(role) ? 200 : 403,
          });
          cases.push({
            role,
            url: "/admin/products",
            expected: ["owner", "catalog_manager", "warehouse"].includes(role) ? 200 : 403,
          });
          cases.push({ role, url: "/admin/stores", expected: 200 });
          cases.push({ role, url: "/admin/route-doc-moi", expected: 403 });
        }
        const all = [...cases, ...cases];
        const results = await Promise.all(all.map((c) => call("GET", c.url, accounts[c.role].headers)));
        expect(all.map((c, i) => ({ ...c, actual: results[i]!.status }))).toEqual(
          all.map((c) => ({ ...c, actual: c.expected })),
        );
      });
    });

    describe("T-147 review: `?fields=` không mở quan hệ ngược tới PII đơn/khách (field-policy.ts)", () => {
      const EMAIL = "khach-t147-fields@example.test";
      const PHONE = "0912345678";
      const STREET = "12 Duong Mau T147";
      interface Fixture {
        regionId: string;
        salesChannelId: string;
        locationId: string;
        productId: string;
        variantId: string;
        inventoryItemId: string;
        orderId: string;
      }
      let fx: Fixture;

      beforeEach(async () => {
        const region = await container
          .resolve(Modules.REGION)
          .createRegions({ name: "VN-T147F", currency_code: "vnd" });
        const sc = await container.resolve(Modules.SALES_CHANNEL).createSalesChannels({ name: "kenh-t147f" });
        const loc = await container
          .resolve(Modules.STOCK_LOCATION)
          .createStockLocations({ name: "kho-t147f" });
        const [customer] = await container
          .resolve(Modules.CUSTOMER)
          .createCustomers([{ email: EMAIL, phone: PHONE, first_name: "Khach", last_name: "Fields" }]);
        const [product] = await container.resolve(Modules.PRODUCT).createProducts([
          {
            title: "Ao T147F",
            options: [{ title: "Size", values: ["M"] }],
            variants: [{ title: "M", sku: "T147F-M", options: { Size: "M" } }],
          },
        ]);
        const variant = product!.variants[0]!;
        const inventory = container.resolve(Modules.INVENTORY);
        const [item] = await inventory.createInventoryItems([{ sku: "T147F-M", title: "Ao T147F M" }]);
        await inventory.createInventoryLevels([
          { inventory_item_id: item!.id, location_id: loc.id, stocked_quantity: 5 },
        ]);
        const order = (await container.resolve(Modules.ORDER).createOrders({
          email: EMAIL,
          region_id: region.id,
          sales_channel_id: sc.id,
          customer_id: customer!.id,
          currency_code: "vnd",
          shipping_address: {
            first_name: "Khach",
            last_name: "Fields",
            phone: PHONE,
            address_1: STREET,
            country_code: "vn",
          },
          items: [
            {
              title: "Ao",
              quantity: 1,
              unit_price: 100_000,
              variant_id: variant.id,
              product_id: product!.id,
            },
          ],
        } as never)) as unknown as { id: string };
        await createPromotion(container, "T147FIELDS", { limit: null, percent: 10 });
        const [promo] = await container.resolve(Modules.PROMOTION).listPromotions({ code: "T147FIELDS" });
        await container.resolve(ContainerRegistrationKeys.LINK).create([
          { [Modules.ORDER]: { order_id: order.id }, [Modules.PROMOTION]: { promotion_id: promo!.id } },
          {
            [Modules.SALES_CHANNEL]: { sales_channel_id: sc.id },
            [Modules.STOCK_LOCATION]: { stock_location_id: loc.id },
          },
          {
            [Modules.PRODUCT]: { product_id: product!.id },
            [Modules.SALES_CHANNEL]: { sales_channel_id: sc.id },
          },
          {
            [Modules.PRODUCT]: { variant_id: variant.id },
            [Modules.INVENTORY]: { inventory_item_id: item!.id },
          },
        ]);
        fx = {
          regionId: region.id,
          salesChannelId: sc.id,
          locationId: loc.id,
          productId: product!.id,
          variantId: variant.id,
          inventoryItemId: item!.id,
          orderId: order.id,
        };
      });

      const leaks = (data: unknown) => {
        const text = JSON.stringify(data ?? "");
        return text.includes(EMAIL) || text.includes(PHONE) || text.includes(STREET);
      };

      /** URL dò của review T-147 (+ hai đường nghi ngờ qua hoàn tiền / nhà cung cấp thanh toán). */
      const probes = (f: Fixture) => [
        `/admin/regions?fields=id,orders.email,orders.shipping_address.*`,
        `/admin/regions/${f.regionId}?fields=id,orders.email,orders.customer.phone`,
        `/admin/regions?fields=+orders.email`,
        `/admin/regions?fields=id&order=orders.email`,
        `/admin/regions?fields=id,payment_providers.payment_collections.*`,
        `/admin/sales-channels?fields=id,orders.email,orders.shipping_address.*`,
        `/admin/sales-channels/${f.salesChannelId}?fields=id,orders.email,orders.customer.phone`,
        `/admin/sales-channels?fields=id,carts.email`,
        `/admin/stores?fields=id,default_sales_channel.orders.email`,
        `/admin/refund-reasons?fields=id,refunds.payment.payment_collection.order.*`,
        `/admin/stock-locations?fields=id,sales_channels.orders.email,sales_channels.orders.shipping_address.*`,
        `/admin/products?fields=id,sales_channels.orders.email,sales_channels.orders.shipping_address.*`,
        `/admin/products?fields=id,*variants.order_items`,
        `/admin/products/${f.productId}/variants/${f.variantId}?fields=id,product.sales_channels.orders.email`,
        `/admin/inventory-items/${f.inventoryItemId}?fields=id,variants.product.sales_channels.orders.email`,
        `/admin/promotions?fields=id,order_link.order.email,order_link.order.shipping_address.*`,
        `/admin/promotions?fields=id,ORDER_LINK.order.email`,
        `/admin/users/me?fields=id,rbac_roles.users.email`,
      ];

      it("CSKH/kho/catalog: mọi URL dò → 403, không lộ email/SĐT/địa chỉ; audit forbidden_fields", async () => {
        const actual: { role: string; url: string; status: number; leak: boolean }[] = [];
        for (const role of ["support", "warehouse", "catalog_manager"] as const) {
          for (const url of probes(fx)) {
            const res = await call("GET", url, accounts[role].headers);
            actual.push({ role, url, status: res.status, leak: leaks(res.data) });
          }
        }
        expect(actual).toEqual(actual.map((a) => ({ ...a, status: 403, leak: false })));
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { action: "rbac.denied", actor_id: accounts.warehouse.userId },
          { limit: 50, offset: 0 },
        );
        const fieldDenial = entries.find(
          (e) =>
            (e.changes as { reason?: string } | null)?.reason === "forbidden_fields" &&
            e.resource_id === "GET /admin/regions",
        );
        expect(fieldDenial).toMatchObject({
          changes: {
            reason: "forbidden_fields",
            roles: ["warehouse"],
            fields: expect.arrayContaining(["orders.email"]),
          },
        });
        expect(JSON.stringify(entries)).not.toContain(EMAIL);
      });

      it("owner/nhân viên đơn/kế toán (order.read) vẫn đọc đơn và quan hệ đơn như thường", async () => {
        for (const role of ["owner", "order_staff", "accountant"] as const) {
          const orders = await call(
            "GET",
            "/admin/orders?fields=id,email,*shipping_address",
            accounts[role].headers,
          );
          expect({ role, status: orders.status, leak: leaks(orders.data) }).toEqual({
            role,
            status: 200,
            leak: true,
          });
          const region = await call(
            "GET",
            `/admin/regions/${fx.regionId}?fields=id,orders.email`,
            accounts[role].headers,
          );
          expect({ role, status: region.status, leak: leaks(region.data) }).toEqual({
            role,
            status: 200,
            leak: true,
          });
        }
      });

      it("màn dashboard hợp lệ của kho/catalog chạy với đúng `fields` dashboard gửi (200, không lộ PII)", async () => {
        const screens = [
          // @medusajs/dashboard src/routes/locations/location-list/constants.ts, location-detail/constants.ts
          "/admin/stock-locations?fields=name,*sales_channels,*address,*fulfillment_sets,*fulfillment_sets.service_zones,*fulfillment_sets.service_zones.shipping_options,*fulfillment_sets.service_zones.shipping_options.shipping_profile",
          `/admin/stock-locations/${fx.locationId}?fields=name,metadata,*sales_channels,*address,fulfillment_sets.type,fulfillment_sets.name,*fulfillment_sets.service_zones.geo_zones,*fulfillment_sets.service_zones,*fulfillment_sets.service_zones.shipping_options,*fulfillment_sets.service_zones.shipping_options.rules,*fulfillment_sets.service_zones.shipping_options.shipping_profile,*fulfillment_providers`,
          // src/routes/inventory/inventory-detail/constants.ts
          `/admin/inventory-items/${fx.inventoryItemId}?fields=*variants,*variants.product,*variants.options`,
          // src/routes/products/product-detail/constants.ts
          `/admin/products/${fx.productId}?fields=*categories,*shipping_profile,-variants`,
          "/admin/products",
          `/admin/products/${fx.productId}`,
          "/admin/regions",
          "/admin/sales-channels",
          "/admin/stores",
        ];
        for (const role of ["warehouse", "catalog_manager"] as const) {
          for (const url of screens) {
            const res = await call("GET", url, accounts[role].headers);
            expect({ role, url, status: res.status, leak: leaks(res.data) }).toEqual({
              role,
              url,
              status: 200,
              leak: false,
            });
          }
        }
      });

      it("biến thể kèm tồn: nhân viên đơn chỉ nhận trường tồn kho (form vận đơn), không đọc catalog qua product/prices", async () => {
        const base = `/admin/products/${fx.productId}/variants/${fx.variantId}`;
        // Đúng `fields` form tạo vận đơn của dashboard (order-create-fulfillment-item.tsx).
        const form = await call(
          "GET",
          `${base}?fields=*inventory,*inventory.location_levels,*inventory_items`,
          accounts.order_staff.headers,
        );
        expect(form.status).toBe(200);
        const variant = form.data.variant as Record<string, unknown>;
        expect(variant.id).toBe(fx.variantId);
        expect(variant.inventory).toEqual([
          expect.objectContaining({ id: fx.inventoryItemId, location_levels: [expect.anything()] }),
        ]);
        // Trường mặc định ngoài allowlist bị Medusa gỡ (req.allowed) — không có giá/tuỳ chọn/sản phẩm.
        for (const key of ["prices", "options", "product", "product_id", "barcode", "metadata"])
          expect({ key, present: key in variant }).toEqual({ key, present: false });
        for (const url of [
          `${base}?fields=id,product.title,product.description`,
          `${base}?fields=*product`,
          `${base}?fields=+prices`,
          `${base}?fields=id,inventory.variants.product.title`,
          `${base}?fields=id&order=product.title`,
        ]) {
          const res = await call("GET", url, accounts.order_staff.headers);
          expect({ url, status: res.status }).toEqual({ url, status: 403 });
        }
        // Có catalog.read (kho, catalog, owner): đọc đầy đủ như trước.
        for (const role of ["warehouse", "catalog_manager", "owner"] as const) {
          const res = await call("GET", `${base}?fields=id,product.title,*prices`, accounts[role].headers);
          expect({ role, status: res.status }).toEqual({ role, status: 200 });
          expect((res.data.variant as { product: { title: string } }).product.title).toBe("Ao T147F");
        }
      });

      it("đồng thời: 36 request song song trộn vai trò × URL dò/hợp lệ → mỗi request đúng kết quả, không lộ PII", async () => {
        const urls = [
          `/admin/regions?fields=id,orders.email`,
          `/admin/sales-channels?fields=id,orders.email`,
          "/admin/regions",
        ];
        const cases = ROLES.flatMap((role) =>
          urls.map((url, i) => ({
            role,
            url,
            expected: i === 2 || ["owner", "order_staff", "accountant"].includes(role) ? 200 : 403,
          })),
        );
        const all = [...cases, ...cases];
        const results = await Promise.all(all.map((c) => call("GET", c.url, accounts[c.role].headers)));
        expect(
          all.map((c, i) => ({
            ...c,
            actual: results[i]!.status,
            leak: c.expected === 403 && leaks(results[i]!.data),
          })),
        ).toEqual(all.map((c) => ({ ...c, actual: c.expected, leak: false })));
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

    describe("T-145: request-target dạng URL tuyệt đối / %xx không lách RBAC", () => {
      const EMAIL = "khach-t145@example.test";
      const PHONE = "0933222111";
      let customerId: string;
      let port: number;

      beforeEach(async () => {
        port = Number(
          new URL(String((rawApi as unknown as { defaults: { baseURL: string } }).defaults.baseURL)).port,
        );
        const [customer] = await container
          .resolve(Modules.CUSTOMER)
          .createCustomers([{ email: EMAIL, phone: PHONE, first_name: "Khach", last_name: "T145" }]);
        customerId = customer!.id;
      });

      const leaks = (text: string) => text.includes(EMAIL) || text.includes(PHONE);

      it("support + `GET http://host/admin/customers/<id>` và `/admin/x/audit` → 400 trước Express, không lộ PII; mọi vai trò", async () => {
        for (const target of [
          `http://localhost:${port}/admin/customers/${customerId}`,
          `HTTP://LOCALHOST:${port}/ADMIN/CUSTOMERS/${customerId}`,
          `http://localhost:${port}/admin/x/audit`,
          `http://localhost:${port}/admin/x/audit?limit=50`,
        ]) {
          for (const role of ["support", "owner"] as const) {
            const res = await rawRequest(port, target, accounts[role].headers);
            expect({ role, target, status: res.status, code: res.json.code }).toEqual({
              role,
              target,
              status: 400,
              code: "INVALID_REQUEST_TARGET",
            });
            expect(leaks(res.text)).toBe(false);
          }
        }
        // Lớp server vẫn ghi log truy cập cho request bị chặn (không query, không PII).
        const rejected = accessLog
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r["http.response.status_code"] === 400 && /^https?:/i.test(String(r["url.path"])));
        expect(rejected.length).toBeGreaterThanOrEqual(8);
        expect(accessLog.join("\n")).not.toContain("limit=50");
      });

      it("luồng thường không đổi: support origin-form → 403 + audit; owner → 200 có dữ liệu khách", async () => {
        const denied = await rawRequest(port, `/admin/customers/${customerId}`, accounts.support.headers);
        expect({ status: denied.status, code: denied.json.code }).toEqual({ status: 403, code: "FORBIDDEN" });
        expect(leaks(denied.text)).toBe(false);
        expect((await rawRequest(port, "/admin/x/audit", accounts.support.headers)).status).toBe(403);
        const ok = await call("GET", `/admin/customers/${customerId}`, accounts.owner.headers);
        expect(ok.status).toBe(200);
        expect((ok.data.customer as { email: string }).email).toBe(EMAIL);
        expect((await call("GET", "/admin/x/audit", accounts.owner.headers)).status).toBe(200);
      });

      it("%61dmin, %63ustomers, `\\`+`#`, `//` không lách: support không bao giờ nhận 200/PII; lần từ chối có audit", async () => {
        const variants: [string, number][] = [
          [`/admin/%63ustomers/${customerId}`, 403],
          [`/admin/%63%75%73%74%6F%6D%65%72%73/${customerId}`, 403],
          // D-079: `#`/`\\` bị lớp server chặn (400) trước Express.
          [`/admin\\customers/${customerId}#x`, 400],
          [`/ADMIN\\Customers/${customerId}#x`, 400],
          [`/admin\\customers/${customerId}`, 400],
          [`/admin/customers/${customerId}%2F`, 403],
          [`/admin/customers/%zz`, 400],
          [`/%61dmin/customers/${customerId}`, 404],
          [`//admin/customers/${customerId}`, 404],
        ];
        const actual = [];
        for (const [target] of variants) {
          const res = await rawRequest(port, target, accounts.support.headers);
          actual.push({ target, status: res.status, leak: leaks(res.text) });
        }
        expect(actual).toEqual(variants.map(([target, status]) => ({ target, status, leak: false })));
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const { entries } = await audit.list(
          { action: "rbac.denied", actor_id: accounts.support.userId },
          { limit: 20, offset: 0 },
        );
        expect(entries.map((e) => e.resource_id)).toContain(
          `GET /admin/customers/${customerId.toLowerCase()}`,
        );
      });

      it("D-079: support + `GET /admin\\customers/<id>#y` (socket thô) → 400 INVALID_REQUEST_TARGET trước Express, không lộ PII", async () => {
        for (const target of [`/admin\\customers/${customerId}#y`, `/admin/customers/${customerId}#y`]) {
          const res = await rawRequest(port, target, accounts.support.headers);
          expect({ target, status: res.status, code: res.json.code, leak: leaks(res.text) }).toEqual({
            target,
            status: 400,
            code: "INVALID_REQUEST_TARGET",
            leak: false,
          });
        }
      });

      it("đồng thời: 20 request trộn (tuyệt đối/origin-form) song song → mỗi request đúng kết quả, không lộ PII", async () => {
        const jobs = Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? rawRequest(
                port,
                `http://localhost:${port}/admin/customers/${customerId}`,
                accounts.support.headers,
              )
            : rawRequest(port, `/admin/customers/${customerId}`, accounts.support.headers),
        );
        const results = await Promise.all(jobs);
        expect(results.map((r) => r.status)).toEqual(
          Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 400 : 403)),
        );
        expect(results.some((r) => leaks(r.text))).toBe(false);
      });
    });
  },
});
