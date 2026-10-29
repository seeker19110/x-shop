import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import seedXShop from "../../src/scripts/seed";
import { createAdmin, noThrow } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-182 (SEC-INFRA-010) — không tài khoản/mật khẩu mặc định: seed và dev-services.sh không tạo admin với mật khẩu cố định;
 * đăng nhập bằng cặp mặc định phổ biến bị từ chối (không lộ "user tồn tại"); không endpoint chẩn đoán/quản trị mở công khai.
 * Vế quét hạ tầng production (Grafana, pgAdmin, /metrics từ ngoài) thuộc chủ dự án, ngoài phạm vi test này.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Mật khẩu mặc định phổ biến (danh sách công khai kiểu SecLists/hướng dẫn Medusa). */
const COMMON_PASSWORDS = [
  "admin",
  "supersecret",
  "password",
  "123456",
  "medusa",
  "changeme",
  "admin123",
  "12345678",
  "Password1",
];
// Email admin mặc định của tài liệu Medusa (miền thật medusa-test.com) không đưa vào fixture (check-fixtures):
// ca "sau seed không có auth identity" đã phủ mọi email, kể cả email đó.
const COMMON_EMAILS = ["admin@example.test", "admin@x-shop.test", "root@example.test"];

/** Endpoint GET nhạy cảm phổ biến — không được trả 200 kèm dữ liệu khi không token. */
const SENSITIVE_PATHS = [
  "/metrics",
  "/health/debug",
  "/debug",
  "/_debug",
  "/.env",
  "/config",
  "/admin/users",
  "/admin/users/me",
  "/admin/orders",
  "/admin/products",
  "/admin/api-keys",
  "/admin/store",
  "/admin/invites",
  "/actuator/env",
  "/graphql",
  "/swagger.json",
  "/openapi.json",
  "/admin/__debug",
  "/server-status",
];
// Ghi chú phạm vi: `/app` (dashboard admin) phụ thuộc DISABLE_MEDUSA_ADMIN ở production — thuộc kiểm cấu hình triển khai của chủ
// dự án; `/_next/*` thuộc storefront, ngoài backend. Admin E2E (E2E_ADMIN) chỉ là tài khoản dùng cho test, không có ở seed/production.
// Probe công khai có chủ đích (/x/health, /x/readyz) được kiểm riêng bên dưới: không lộ chi tiết.

const SEED_SOURCES = [
  "apps/backend/src/scripts/seed.ts",
  "apps/backend/src/scripts/seed-catalog.ts",
  "apps/backend/src/scripts/catalog-demo-data.ts",
  "apps/backend/src/scripts/grant-owner.ts",
  "scripts/dev-services.sh",
];

describe("T-182 không tài khoản mặc định (tĩnh)", () => {
  it.each(SEED_SOURCES)("%s không có admin/mật khẩu cố định", (rel) => {
    const src = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    // Chỉ là lưới thô (regex tĩnh); hàng rào thật là các ca runtime (không user, không auth identity, đăng nhập bị từ chối).
    // Không tạo user/auth identity với mật khẩu (emailpass) và không gán cứng mật khẩu mặc định phổ biến.
    expect(src).not.toMatch(/createUser|createAuthIdentit|emailpass|registerProvider/i);
    expect(src).not.toMatch(
      /(?:password|passwd|pwd)\s*[:=]\s*["'](?:admin|supersecret|password|123456|medusa|changeme)["']/i,
    );
  });

  it("dev-services.sh chỉ tạo role DB cục bộ, không có tài khoản ứng dụng/quản trị", () => {
    const src = readFileSync(path.join(REPO_ROOT, "scripts/dev-services.sh"), "utf8");
    expect(src).not.toMatch(/medusa\s+user|create-?admin|-u\s+admin/i);
  });
});

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    beforeEach(async () => {
      await seedXShop({ container: getContainer() });
    });

    const login = (email: string, password: string) =>
      api.post("/auth/user/emailpass", { email, password }, noThrow) as Promise<{
        status: number;
        data: Record<string, unknown>;
      }>;

    it("sau seed không có user admin nào", async () => {
      const users = await getContainer().resolve(Modules.USER).listUsers({});
      expect(users).toHaveLength(0);
    });

    it("sau seed không có auth identity/provider identity nào", async () => {
      const auth = getContainer().resolve(Modules.AUTH);
      expect(await auth.listAuthIdentities({})).toHaveLength(0);
      expect(await auth.listProviderIdentities({})).toHaveLength(0);
    });

    it("sau seed, không cặp mặc định phổ biến nào đăng nhập được", async () => {
      // Phủ MỌI cặp (email × mật khẩu); mỗi định danh chỉ nhận ≤ ngưỡng perIdentityIp-1 lần thử (tránh 429 che kết quả) —
      // vượt thì dùng alias +n của cùng email (vẫn là cặp phổ biến).
      const per = AUTH_RATE_LIMITS.login.perIdentityIp - 1;
      let total = 0;
      for (const email of COMMON_EMAILS) {
        for (const [i, pw] of COMMON_PASSWORDS.entries()) {
          const n = Math.floor(i / per);
          const addr = n === 0 ? email : email.replace("@", `+${n}@`);
          const res = await login(addr, pw);
          expect(res.status).toBe(401);
          expect(res.data.token).toBeUndefined();
          total++;
        }
      }
      expect(total).toBe(COMMON_EMAILS.length * COMMON_PASSWORDS.length);
    });

    it("admin thật: mật khẩu mặc định bị từ chối, phản hồi y hệt email không tồn tại (không lộ user)", async () => {
      const admin = await createAdmin(api, getContainer());
      const unknown = await login("khong-ton-tai@example.test", "SENTINEL-sai");
      expect(unknown.status).toBe(401);
      // Chừa 1 lần cho mật khẩu đúng trong ngưỡng perIdentityIp.
      for (const pw of COMMON_PASSWORDS.slice(0, AUTH_RATE_LIMITS.login.perIdentityIp - 2)) {
        const res = await login(admin.email, pw);
        expect(res.status).toBe(401);
        expect(res.data.token).toBeUndefined();
        // Cùng thân phản hồi (trừ trace_id theo request).
        expect({ ...res.data, trace_id: null }).toEqual({ ...unknown.data, trace_id: null });
      }
      // Mật khẩu đúng vẫn vào được: bằng chứng test không xanh giả.
      expect((await login(admin.email, admin.password)).status).toBe(200);
    });

    it("mật khẩu rỗng/thiếu bị từ chối bằng 400/401 (không do rate limit)", async () => {
      const empty = await login(`${randomUUID()}@example.test`, "");
      expect(empty.status).not.toBe(429);
      expect([400, 401]).toContain(empty.status);
      expect(empty.data.token).toBeUndefined();
      const missing = (await api.post(
        "/auth/user/emailpass",
        { email: `${randomUUID()}@example.test` },
        noThrow,
      )) as { status: number; data: Record<string, unknown> };
      expect(missing.status).not.toBe(429);
      expect([400, 401]).toContain(missing.status);
      expect(missing.data.token).toBeUndefined();
    });

    it.each(["/x/health", "/x/readyz"])(
      "probe công khai %s không lộ version/chi tiết phụ thuộc",
      async (p) => {
        const res = (await api.get(p, noThrow)) as { data: unknown };
        const body = JSON.stringify(res.data ?? "");
        expect(body).not.toMatch(
          /ECONN|5432|6379|select|postgres|redis|knex|version|medusa|\bat .*\.(js|ts)/i,
        );
      },
    );

    it.each(SENSITIVE_PATHS)("GET %s không token: không 200 có dữ liệu", async (p) => {
      const res = (await api.get(p, noThrow)) as { status: number };
      expect([401, 403, 404]).toContain(res.status);
    });
  },
});
