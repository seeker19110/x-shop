import { defineConfig, loadEnv } from "@medusajs/framework/utils";
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
  },
  admin: {
    disable: env.DISABLE_MEDUSA_ADMIN,
    ...(env.MEDUSA_BACKEND_URL !== undefined && { backendUrl: env.MEDUSA_BACKEND_URL }),
  },
  modules: [
    ...redisModules,
    // Module tùy biến: checkout attempt, idempotency, quote, ledger, inbox/outbox, ngoại lệ (docs/design/checkout-flow.md).
    { resolve: "./src/modules/checkout" },
    // Catalog thời trang: bảng size có version, thuộc tính, bảng màu/size (T-013).
    { resolve: "./src/modules/fashion" },
    // Read model tìm/lọc cùng SKU `catalog_variant_index` (T-014, D-004).
    { resolve: "./src/modules/catalog-index" },
    // Nhập CSV catalog: preview/commit idempotent theo import id (T-015).
    { resolve: "./src/modules/catalog-import" },
    // Giao vận: vận đơn GHN + sự kiện callback đã lọc PII (T-026, SPEC-fulfillment S-301…S-305).
    { resolve: "./src/modules/shipping" },
  ],
});
