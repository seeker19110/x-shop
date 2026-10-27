/**
 * T-146 / D-077: kiểm trên Redis THẬT (a) lần chạy hiện tại đang giữ độc quyền Redis DB do globalSetup giành và worker
 * nhận đúng DB đó qua env, (b) Lua gia hạn/trả so token đúng trên Redis thật, (c) hai client giành đồng thời một DB →
 * đúng một bên thắng. Phần (b)(c) dùng tiền tố khoá riêng và `flushDb` giả — không đụng khoá/DB của lần chạy nào.
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  LOCK_DB,
  LOCK_KEY_PREFIX,
  TEST_REDIS_DBS,
  acquireRedisDb,
  redisUrlDb,
  withRedisDb,
} from "../redis-db-lease";

jest.setTimeout(30_000);

describe("Redis DB test độc quyền (T-146)", () => {
  const url = new URL(process.env.REDIS_URL as string);
  let lockClient: Redis;
  let other: Redis;

  beforeAll(() => {
    lockClient = new Redis(withRedisDb(url, LOCK_DB), { maxRetriesPerRequest: 1 });
    other = new Redis(withRedisDb(url, LOCK_DB), { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    await lockClient.quit();
    await other.quit();
  });

  it("worker chạy trên DB globalSetup đã giành; khoá ở DB 0 mang token của lần chạy này và còn TTL", async () => {
    const db = Number(process.env.XS_TEST_REDIS_DB);
    expect(TEST_REDIS_DBS).toContain(db);
    expect(redisUrlDb(url)).toBe(db);
    process.stderr.write(`[redis-db-lease.spec] pid ${process.pid} chạy trên Redis DB ${db}\n`);
    expect(await lockClient.get(`${LOCK_KEY_PREFIX}${db}`)).toBe(process.env.XS_TEST_REDIS_DB_TOKEN);
    expect(await lockClient.ttl(`${LOCK_KEY_PREFIX}${db}`)).toBeGreaterThan(0);
  });

  it("Lua thật: gia hạn/trả chỉ với đúng token; trả không xoá khoá người khác", async () => {
    const keyPrefix = `x-shop:test-db-lock-spec:${randomUUID()}:`;
    const flushed: number[] = [];
    const flushDb = async (db: number) => {
      flushed.push(db);
    };
    const a = await acquireRedisDb({
      redis: lockClient,
      flushDb,
      keyPrefix,
      dbs: [1, 2],
      ttlSec: 30,
      renewMs: 10_000,
    });
    const b = await acquireRedisDb({
      redis: other,
      flushDb,
      keyPrefix,
      dbs: [1, 2],
      ttlSec: 30,
      renewMs: 10_000,
    });
    try {
      expect([a.db, b.db]).toEqual([1, 2]);
      expect(flushed).toEqual([1, 2]);
      await expect(
        acquireRedisDb({ redis: other, flushDb, keyPrefix, dbs: [1, 2], waitMs: 0 }),
      ).rejects.toThrow(/hết Redis DB test/);

      await lockClient.expire(a.key, 5);
      expect(await a.renew()).toBe(true);
      expect(await lockClient.ttl(a.key)).toBeGreaterThan(5);

      // Khoá của a bị thay bằng token khác (a mất khoá) → a không gia hạn hộ, không xoá.
      await lockClient.set(a.key, "chu-khac", "EX", 30);
      expect(await a.renew()).toBe(false);
      expect(a.lost).toBe(true);
      expect(await a.release()).toBe(false);
      expect(await lockClient.get(a.key)).toBe("chu-khac");

      expect(await b.release()).toBe(true);
      expect(await lockClient.get(b.key)).toBeNull();
    } finally {
      await a.release();
      await b.release();
      await lockClient.del(`${keyPrefix}1`, `${keyPrefix}2`);
    }
  });

  it("đồng thời: hai client giành cùng một DB → đúng một bên thắng, bên kia lỗi hết DB", async () => {
    const keyPrefix = `x-shop:test-db-lock-spec:${randomUUID()}:`;
    const flushDb = async () => undefined;
    const results = await Promise.allSettled(
      [lockClient, other].map((redis) => acquireRedisDb({ redis, flushDb, keyPrefix, dbs: [3], waitMs: 0 })),
    );
    try {
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/hết Redis DB test/);
    } finally {
      for (const r of results) if (r.status === "fulfilled") await r.value.release();
      await lockClient.del(`${keyPrefix}3`);
    }
  });
});
