/**
 * Timeout TƯỜNG MINH cho mọi lời gọi ra ngoài của backend (T-092 — BASE-ERR-004, ARC-RES-001, BE-REL-001, DB-PERF-004,
 * DB-TX-003). Bảng tổng hợp + phép tính kết nối: docs/db/connections.md.
 *
 * Postgres (Medusa 2.22.1 `@medusajs/framework` pg-connection-loader → `ModulesSdkUtils.createPgConnection` → knex/pg):
 *  - `databaseDriverOptions.connectionTimeoutMillis` → pg `connectionTimeoutMillis` (mở kết nối TCP + startup);
 *  - `databaseDriverOptions.idle_in_transaction_session_timeout` → tham số phiên Postgres (giết phiên giữ transaction
 *    nhàn rỗi — chặn giữ khoá/cạn pool khi code lỡ chờ việc khác trong transaction);
 *  - `databaseDriverOptions.pool.{min,max,idleTimeoutMillis}` → pool tarn của knex;
 *  - `statement_timeout`: createPgConnection KHÔNG chuyển khoá này từ driverOptions → đặt bằng tham số trên URL
 *    (pg-connection-string chép mọi query param vào cấu hình, pg gửi trong gói startup). URL đã có thì giữ của URL;
 *  - timeout LẤY kết nối từ pool: knex 3.2.10 mặc định `acquireConnectionTimeout` = 60 000 ms; Medusa 2.22.1 chỉ chuyển
 *    pool.min/max/idleTimeoutMillis/reapIntervalMillis/createRetryIntervalMillis nên KHÔNG cấu hình được — ghi lại ở
 *    `DB_TIMEOUTS.poolAcquireTimeoutMs` để tài liệu/kiểm thử bám một chỗ.
 *
 * Redis (ioredis 5): `connectTimeout` cho mọi kết nối; `commandTimeout` chỉ cho kết nối lệnh-trả-lời-ngay (cache,
 * caching, locking, kho phiên, kho bảo mật). Kết nối BullMQ (event bus, workflow engine) dùng lệnh CHẶN (BZPOPMIN…) —
 * ioredis áp `commandTimeout` cả cho lệnh chặn nên KHÔNG đặt ở đó (BullMQ tự quản hạn chờ của nó, `maxRetriesPerRequest:
 * null` do Medusa đặt theo yêu cầu của BullMQ).
 *
 * HTTP ra vendor: VNPAY querydr `CHECKOUT_CONFIG.queryTimeoutMs`, GHN `SHIPPING_CONFIG.requestTimeoutMs` (AbortSignal.timeout
 * phủ cả đọc thân); Admin UI → backend `ADMIN_FETCH_TIMEOUT_MS` (src/admin/lib/api.ts).
 */

export const DB_TIMEOUTS = {
  /** Mở kết nối mới (TCP + TLS + startup) — Postgres treo/không tới được → lỗi sau chừng này. */
  connectTimeoutMs: 5_000,
  /** Phiên giữ transaction mà không chạy lệnh quá chừng này → Postgres huỷ phiên (khoá được nhả). */
  idleInTransactionTimeoutMs: 60_000,
  /** Kết nối rảnh trong pool bị đóng sau chừng này. */
  poolIdleTimeoutMs: 30_000,
  /** Mặc định knex 3.2.10 (không cấu hình được qua Medusa 2.22.1) — chờ lấy kết nối khi pool cạn. */
  poolAcquireTimeoutMs: 60_000,
  /** pool.min mặc định của Medusa (giữ nguyên). */
  poolMin: 2,
} as const;

export const REDIS_TIMEOUTS = {
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 5_000,
} as const;

export interface DatabaseEnv {
  DATABASE_URL: string;
  DB_POOL_MAX: number;
  DB_STATEMENT_TIMEOUT_MS: number;
}

export interface DatabaseConfig {
  databaseUrl: string;
  databaseDriverOptions: {
    connectionTimeoutMillis: number;
    idle_in_transaction_session_timeout: number;
    pool: { min: number; max: number; idleTimeoutMillis: number };
  };
}

/** Thêm `statement_timeout` (ms) vào URL Postgres nếu URL chưa khai; giữ nguyên mọi phần khác. */
export function withStatementTimeout(databaseUrl: string, statementTimeoutMs: number): string {
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new Error("statement_timeout phải là số nguyên dương (ms)");
  }
  const url = new URL(databaseUrl);
  if (url.searchParams.has("statement_timeout")) return databaseUrl;
  url.searchParams.set("statement_timeout", String(statementTimeoutMs));
  return url.toString();
}

/** `projectConfig.databaseUrl` + `databaseDriverOptions` cho medusa-config. */
export function databaseConfig(env: DatabaseEnv): DatabaseConfig {
  if (!Number.isSafeInteger(env.DB_POOL_MAX) || env.DB_POOL_MAX < 1) {
    throw new Error("DB_POOL_MAX phải là số nguyên ≥ 1");
  }
  return {
    databaseUrl: withStatementTimeout(env.DATABASE_URL, env.DB_STATEMENT_TIMEOUT_MS),
    databaseDriverOptions: {
      connectionTimeoutMillis: DB_TIMEOUTS.connectTimeoutMs,
      idle_in_transaction_session_timeout: DB_TIMEOUTS.idleInTransactionTimeoutMs,
      pool: {
        min: Math.min(DB_TIMEOUTS.poolMin, env.DB_POOL_MAX),
        max: env.DB_POOL_MAX,
        idleTimeoutMillis: DB_TIMEOUTS.poolIdleTimeoutMs,
      },
    },
  };
}

/** ioredis cho kết nối lệnh-trả-lời-ngay (cache, caching, locking, kho phiên, kho bảo mật). */
export function redisRequestOptions(): { connectTimeout: number; commandTimeout: number } {
  return { connectTimeout: REDIS_TIMEOUTS.connectTimeoutMs, commandTimeout: REDIS_TIMEOUTS.commandTimeoutMs };
}

/** ioredis cho kết nối BullMQ (event bus, workflow engine): chỉ hạn mở kết nối — lệnh chặn không được có commandTimeout. */
export function redisQueueOptions(): { connectTimeout: number } {
  return { connectTimeout: REDIS_TIMEOUTS.connectTimeoutMs };
}
