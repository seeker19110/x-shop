import {
  LOCK_KEY_PREFIX,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  RedisDbExhaustedError,
  TEST_REDIS_DBS,
  acquireRedisDb,
  redisUrlDb,
  withRedisDb,
  type LeaseRedis,
} from "../redis-db-lease";

/** Redis giả một luồng (như Redis thật: mỗi lệnh nguyên tử), hết hạn theo Date.now() (fake timers điều khiển). */
class FakeRedis implements LeaseRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  down = false;

  private live(key: string) {
    const e = this.store.get(key);
    if (e !== undefined && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  ttlMs(key: string): number | null {
    const e = this.live(key);
    return e === undefined ? null : e.expiresAt - Date.now();
  }

  async set(key: string, value: string, _ex: "EX", seconds: number, _nx: "NX"): Promise<"OK" | null> {
    if (this.down) throw new Error("ECONNREFUSED");
    if (this.live(key) !== undefined) return null;
    this.store.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return "OK";
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.down) throw new Error("ECONNREFUSED");
    const [key = "", token = "", ttl = "0"] = args.map(String);
    const e = this.live(key);
    if (e === undefined || e.value !== token) return 0;
    if (script === RENEW_SCRIPT) {
      e.expiresAt = Date.now() + Number(ttl) * 1000;
      return 1;
    }
    if (script === RELEASE_SCRIPT) {
      this.store.delete(key);
      return 1;
    }
    throw new Error(`script lạ: ${script}`);
  }
}

const key = (db: number) => `${LOCK_KEY_PREFIX}${db}`;

describe("redis-db-lease (T-146)", () => {
  let redis: FakeRedis;
  let flushed: number[];
  const flushDb = async (db: number) => {
    flushed.push(db);
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    redis = new FakeRedis();
    flushed = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("vùng DB test bỏ DB 0 (dev), 7 (E2E), 13–15 (tải/perf/diễn tập)", () => {
    for (const db of [0, 7, 13, 14, 15]) expect(TEST_REDIS_DBS).not.toContain(db);
    expect(TEST_REDIS_DBS).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
  });

  it("hai lần chạy nhận hai DB khác nhau; mỗi lần chỉ xoá DB của chính mình", async () => {
    const a = await acquireRedisDb({ redis, flushDb, token: "A" });
    const b = await acquireRedisDb({ redis, flushDb, token: "B" });
    expect(a.db).not.toBe(b.db);
    expect([a.db, b.db]).toEqual([1, 2]);
    expect(flushed).toEqual([1, 2]);
    expect(redis.get(key(a.db))).toBe("A");
    expect(redis.get(key(b.db))).toBe("B");
    expect(redis.ttlMs(key(a.db))).toBe(120_000);
    await a.release();
    await b.release();
  });

  it("đồng thời: 11 lần giành song song → 11 DB khác nhau; lần thứ 12 (không chờ) → lỗi hết DB", async () => {
    const leases = await Promise.all(
      TEST_REDIS_DBS.map((_, i) => acquireRedisDb({ redis, flushDb, token: `T${i}` })),
    );
    expect(new Set(leases.map((l) => l.db)).size).toBe(TEST_REDIS_DBS.length);
    expect(new Set(flushed).size).toBe(TEST_REDIS_DBS.length);
    await expect(acquireRedisDb({ redis, flushDb, token: "X", waitMs: 0 })).rejects.toThrow(
      /hết Redis DB test/,
    );
    await Promise.all(leases.map((l) => l.release()));
  });

  it("hết DB trống → chờ có hạn (poll) rồi RedisDbExhaustedError rõ ràng; không xoá DB nào", async () => {
    const holders = await Promise.all(
      TEST_REDIS_DBS.map((_, i) => acquireRedisDb({ redis, flushDb, token: `H${i}` })),
    );
    flushed = [];
    const sleeps: number[] = [];
    const err = await acquireRedisDb({
      redis,
      flushDb,
      waitMs: 2_500,
      pollMs: 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        jest.advanceTimersByTime(ms); // holders gia hạn bằng interval của chính chúng
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedisDbExhaustedError);
    expect((err as Error).message).toMatch(/^hết Redis DB test: mọi DB 1,2,3,4,5,6,8,9,10,11,12 .*2500 ms/);
    expect(sleeps).toEqual([1_000, 1_000, 500]);
    expect(flushed).toEqual([]);
    await Promise.all(holders.map((h) => h.release()));
  });

  it("tiến trình giữ DB chết (không gia hạn) → TTL hết → lần chạy đang chờ giành được DB đó và xoá nó", async () => {
    // Lần chạy "chết": giữ khoá bằng SET trực tiếp, không có interval gia hạn.
    for (const db of TEST_REDIS_DBS) await redis.set(key(db), "dead", "EX", 5, "NX");
    const lease = await acquireRedisDb({
      redis,
      flushDb,
      token: "NEW",
      waitMs: 60_000,
      sleep: async (ms) => {
        jest.advanceTimersByTime(ms);
      },
    });
    expect(lease.db).toBe(1);
    expect(flushed).toEqual([1]);
    expect(redis.get(key(1))).toBe("NEW");
    await lease.release();
  });

  it("interval gia hạn đã unref và giữ khoá sống quá TTL; trả → dừng interval, xoá khoá", async () => {
    const lease = await acquireRedisDb({ redis, flushDb, token: "A", ttlSec: 10, renewMs: 4_000 });
    expect(lease.timer).not.toBeNull();
    expect(lease.timer!.hasRef()).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000); // 6 TTL
    expect(redis.get(key(lease.db))).toBe("A");
    expect(redis.ttlMs(key(lease.db))).toBeGreaterThan(5_000);
    expect(await lease.release()).toBe(true);
    expect(lease.timer).toBeNull();
    expect(redis.get(key(lease.db))).toBeNull();
    expect(await lease.release()).toBe(false); // gọi lại không xoá gì
    expect(await lease.renew()).toBe(false); // đã trả thì không gia hạn/giành lại
    expect(redis.get(key(lease.db))).toBeNull();
  });

  it("trả chỉ xoá khoá đúng token: khoá đã về tay lần chạy khác thì giữ nguyên", async () => {
    const lease = await acquireRedisDb({ redis, flushDb, token: "A", ttlSec: 10, renewMs: 5_000 });
    clearInterval(lease.timer!); // giả event loop treo: không gia hạn
    jest.advanceTimersByTime(10_000);
    const other = await acquireRedisDb({ redis, flushDb, token: "B" });
    expect(other.db).toBe(lease.db);
    expect(await lease.release()).toBe(false);
    expect(redis.get(key(lease.db))).toBe("B");
    await other.release();
  });

  it("gia hạn thấy khoá mất: chưa ai lấy → giành lại; đã có chủ khác → lost + log, không cướp", async () => {
    const logs: string[] = [];
    const lease = await acquireRedisDb({ redis, flushDb, token: "A", log: (m) => logs.push(m) });
    redis.store.delete(key(lease.db)); // vd DB 0 bị FLUSHDB
    expect(await lease.renew()).toBe(true);
    expect(redis.get(key(lease.db))).toBe("A");
    expect(logs.join("\n")).toMatch(/đã giành lại/);

    redis.store.set(key(lease.db), { value: "B", expiresAt: Date.now() + 60_000 });
    expect(await lease.renew()).toBe(false);
    expect(lease.lost).toBe(true);
    expect(redis.get(key(lease.db))).toBe("B");
    expect(logs.join("\n")).toMatch(/MẤT khoá Redis DB 1/);
    await lease.release();
    expect(redis.get(key(lease.db))).toBe("B");
  });

  it("lỗi Redis trong interval gia hạn chỉ ghi log, không ném (không làm sập tiến trình Jest)", async () => {
    const logs: string[] = [];
    const lease = await acquireRedisDb({ redis, flushDb, token: "A", log: (m) => logs.push(m) });
    redis.down = true;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(logs.join("\n")).toMatch(/gia hạn khoá Redis DB 1 lỗi: Error: ECONNREFUSED/);
    redis.down = false;
    await lease.release();
  });

  it("xoá DB lỗi → nhả khoá vừa giành rồi ném lỗi", async () => {
    const err = await acquireRedisDb({
      redis,
      token: "A",
      flushDb: async () => {
        throw new Error("flush hỏng");
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("flush hỏng");
    expect(redis.get(key(1))).toBeNull();
  });

  it("danh sách DB chỉ định (shard ghi sẵn `/k`): chỉ giành đúng DB đó, bận thì chờ rồi lỗi", async () => {
    const holder = await acquireRedisDb({ redis, flushDb, token: "H", dbs: [5] });
    expect(holder.db).toBe(5);
    await expect(acquireRedisDb({ redis, flushDb, dbs: [5], waitMs: 0 })).rejects.toThrow(/mọi DB 5 /);
    await holder.release();
    const again = await acquireRedisDb({ redis, flushDb, dbs: [5], waitMs: 0 });
    expect(again.db).toBe(5);
    await again.release();
  });

  it("tham số sai bị từ chối", async () => {
    await expect(acquireRedisDb({ redis, flushDb, dbs: [] })).rejects.toThrow(/rỗng/);
    await expect(acquireRedisDb({ redis, flushDb, dbs: [0] })).rejects.toThrow(/không hợp lệ: 0/);
    await expect(acquireRedisDb({ redis, flushDb, dbs: [1.5] })).rejects.toThrow(/không hợp lệ/);
    await expect(acquireRedisDb({ redis, flushDb, ttlSec: 0 })).rejects.toThrow(/ttlSec/);
    await expect(acquireRedisDb({ redis, flushDb, ttlSec: 10, renewMs: 6_000 })).rejects.toThrow(/nửa TTL/);
    await expect(acquireRedisDb({ redis, flushDb, waitMs: -1 })).rejects.toThrow(/waitMs/);
    expect(redis.store.size).toBe(0);
  });

  it("redisUrlDb/withRedisDb: đọc/ghi DB index, giữ host/mật khẩu", () => {
    expect(redisUrlDb(new URL("redis://localhost:6379"))).toBeNull();
    expect(redisUrlDb(new URL("redis://localhost:6379/"))).toBeNull();
    expect(redisUrlDb(new URL("redis://localhost:6379/0"))).toBe(0);
    expect(redisUrlDb(new URL("redis://localhost:6379/12"))).toBe(12);
    expect(() => redisUrlDb(new URL("redis://localhost:6379/abc"))).toThrow(/không phải DB index/);
    expect(withRedisDb("redis://:p%40ss@h:6380", 4)).toBe("redis://:p%40ss@h:6380/4");
    expect(withRedisDb(new URL("rediss://u:p@h:6380/3"), 0)).toBe("rediss://u:p@h:6380/0");
  });
});
