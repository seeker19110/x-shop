import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { sessionCookieConfig } from "./src/lib/admin-security/session-cookie";
import { loadEnvOrExit } from "./src/lib/env";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

// Cấu hình sai → in tên biến (không in giá trị) và thoát mã 1 trước khi Medusa khởi động (BASE-CFG-002).
const env = loadEnvOrExit(process.env);

/**
 * Module hạ tầng chạy trên Redis khi có REDIS_URL (bắt buộc ở production): event bus, cache, caching,
 * workflow engine và Locking Module (provider Redis là mặc định — khoá phân tán giữa server và worker,
 * ADR-0001). Không có REDIS_URL (chỉ dev/test) → Medusa dùng bản in-memory, chỉ đúng cho một tiến trình.
 */
const redisModules = env.REDIS_URL
  ? [
      {
        resolve: "@medusajs/medusa/cache-redis",
        options: { redisUrl: env.REDIS_URL },
      },
      {
        resolve: "@medusajs/medusa/caching",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/caching-redis",
              id: "caching-redis",
              is_default: true,
              options: { redisUrl: env.REDIS_URL },
            },
          ],
        },
      },
      {
        resolve: "@medusajs/medusa/event-bus-redis",
        options: { redisUrl: env.REDIS_URL },
      },
      {
        resolve: "@medusajs/medusa/workflow-engine-redis",
        options: { redis: { redisUrl: env.REDIS_URL } },
      },
      {
        resolve: "@medusajs/medusa/locking",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/locking-redis",
              id: "locking-redis",
              is_default: true,
              options: { redisUrl: env.REDIS_URL },
            },
          ],
        },
      },
    ]
  : [];

// Bí mật: chỉ truyền khi đã đặt — khoá `undefined` sẽ đè mặc định dev của Medusa (defineConfig gộp nông).
const http = {
  storeCors: env.STORE_CORS,
  adminCors: env.ADMIN_CORS,
  authCors: env.AUTH_CORS,
  ...(env.JWT_SECRET !== undefined && { jwtSecret: env.JWT_SECRET }),
  ...(env.COOKIE_SECRET !== undefined && { cookieSecret: env.COOKIE_SECRET }),
};

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: env.DATABASE_URL,
    ...(env.REDIS_URL !== undefined && { redisUrl: env.REDIS_URL }),
    workerMode: env.MEDUSA_WORKER_MODE,
    http,
    // Production: cookie phiên `__Host-xshop_sid` (Secure, HttpOnly, SameSite=Lax, Path=/, không Domain) — BE-AUTH-004, T-099.
    ...sessionCookieConfig(env.NODE_ENV),
  },
  admin: {
    disable: env.DISABLE_MEDUSA_ADMIN,
    ...(env.MEDUSA_BACKEND_URL !== undefined && { backendUrl: env.MEDUSA_BACKEND_URL }),
  },
  modules: [
    ...redisModules,
    // Auth Module: provider `emailpass` cân thời gian phản hồi — email không tồn tại cũng tốn một scrypt.verify như sai
    // mật khẩu (BE-AUTH-003, T-099). Tuỳ chọn MFA (AUTH_MFA_ENCRYPTION_KEY) vẫn do defineConfig gộp vào như mặc định.
    {
      resolve: "@medusajs/medusa/auth",
      options: {
        providers: [{ resolve: "./src/lib/admin-security/emailpass", id: "emailpass" }],
      },
    },
    // File Module: provider local bọc lại — tên lưu `<ULID><đuôi theo MIME>` do server sinh, không dùng tên client
    // (BE-FILE-003, T-100). Thay mặc định `@medusajs/medusa/file-local` của defineConfig.
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [{ resolve: "./src/lib/upload", id: "local" }],
      },
    },
    // Module tùy biến: checkout attempt, idempotency, quote, ledger, inbox/outbox, ngoại lệ (docs/design/checkout-flow.md).
    { resolve: "./src/modules/checkout" },
    // Catalog thời trang: bảng size có version, thuộc tính, bảng màu/size (T-013).
    { resolve: "./src/modules/fashion" },
    // Read model tìm/lọc cùng SKU `catalog_variant_index` (T-014, D-004).
    { resolve: "./src/modules/catalog-index" },
    // Nhập CSV catalog: preview/commit idempotent theo import id (T-015).
    { resolve: "./src/modules/catalog-import" },
    // Vai trò admin `user_role` — RBAC tự xây, không dùng RBAC Enterprise (T-023).
    { resolve: "./src/modules/rbac" },
    // Audit log chỉ ghi thêm + sổ điều chỉnh tồn (T-025).
    { resolve: "./src/modules/audit" },
    // Giao vận: vận đơn GHN + sự kiện callback đã lọc PII (T-026, SPEC-fulfillment S-301…S-305).
    { resolve: "./src/modules/shipping" },
    // Thông báo giao dịch: outbound_message theo message key duy nhất, adapter log mặc định (T-029).
    { resolve: "./src/modules/notify" },
    // Đổi trả theo dòng, kiểm định trước restock, hoàn tiền một phần (T-027, POST03, INV04, §6.5).
    { resolve: "./src/modules/returns" },
    // Đối soát COD/sao kê VNPAY: batch chỉ ghi thêm, chênh lệch có lịch sử, báo cáo tách giá trị đơn/tiền thu (T-028).
    { resolve: "./src/modules/settlement" },
  ],
});
