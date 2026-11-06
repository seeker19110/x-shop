/**
 * globalSetup của Jest cho test tích hợp (T-146 / D-077): giành độc quyền một Redis DB (integration-tests/redis-db-lease.ts),
 * xoá sạch DB đó, đặt REDIS_URL/XS_TEST_REDIS_DB cho worker (worker tạo sau globalSetup nên kế thừa process.env).
 * globalTeardown (global-teardown.ts) trả khoá. Chạy trong tiến trình chính của Jest — interval gia hạn sống ở đây.
 *
 * REDIS_URL không ghi DB index → giành DB trống bất kỳ trong vùng test. Đã ghi index thuộc vùng test (vd shard của
 * scripts/test-shards/unit.sh đặt `/k`) → giành ĐÚNG DB đó (chờ nếu lần chạy khác giữ) để hai cơ chế không giẫm nhau.
 * Ghi index ngoài vùng test (0, 7, 13–15…) → dùng nguyên, không giữ khoá, không xoá (người gọi tự chịu cô lập).
 */
import Redis from "ioredis";
import {
  DEFAULT_WAIT_MS,
  LOCK_DB,
  TEST_REDIS_DBS,
  acquireRedisDb,
  redisUrlDb,
  withRedisDb,
  type RedisDbLease,
} from "./redis-db-lease";

export const LEASE_STATE = Symbol.for("x-shop.test-redis-db-lease");
export type LeaseState = { lease: RedisDbLease; client: Redis };

const log = (msg: string) => process.stderr.write(`[redis-db-lease] ${msg}\n`);

function waitMsFromEnv(): number {
  const raw = process.env.XS_TEST_REDIS_DB_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WAIT_MS;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < 0)
    throw new TypeError(`XS_TEST_REDIS_DB_WAIT_MS phải là số ms ≥ 0 (nhận "${raw}")`);
  return v;
}

export default async function globalSetup(): Promise<void> {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  const explicit = redisUrlDb(url);
  if (explicit !== null && !TEST_REDIS_DBS.includes(explicit)) {
    log(
      `REDIS_URL đã ghi DB ${explicit} ngoài vùng test (${TEST_REDIS_DBS.join(",")}) — dùng nguyên, không giữ khoá/không xoá`,
    );
    return;
  }

  const client = new Redis(withRedisDb(url, LOCK_DB), {
    maxRetriesPerRequest: 1,
    connectionName: "x-shop-test-db-lease",
  });
  client.on("error", () => undefined); // lỗi lệnh đã nổi ở promise; tránh "[ioredis] Unhandled error event"
  let lease: RedisDbLease;
  try {
    lease = await acquireRedisDb({
      redis: client,
      dbs: explicit === null ? TEST_REDIS_DBS : [explicit],
      waitMs: waitMsFromEnv(),
      log,
      flushDb: async (db) => {
        const r = new Redis(withRedisDb(url, db), { maxRetriesPerRequest: 1, lazyConnect: true });
        r.on("error", () => undefined);
        try {
          await r.connect();
          await r.flushdb();
        } finally {
          r.disconnect();
        }
      },
    });
  } catch (err) {
    client.disconnect();
    throw err;
  }

  process.env.REDIS_URL = withRedisDb(url, lease.db);
  process.env.XS_TEST_REDIS_DB = String(lease.db);
  process.env.XS_TEST_REDIS_DB_TOKEN = lease.token;
  (globalThis as Record<symbol, unknown>)[LEASE_STATE] = { lease, client } satisfies LeaseState;
  log(
    `giữ Redis DB ${lease.db} (pid ${process.pid}, khoá ${lease.key} ở DB ${LOCK_DB}) — đã xoá sạch DB này`,
  );
}
