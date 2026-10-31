/**
 * T-146 / D-077: mỗi lần chạy test tích hợp giữ ĐỘC QUYỀN một Redis DB index.
 *
 * Trước đây jest.config.js chọn DB theo `pid % 12` → hai lần chạy đồng thời trên cùng máy (cổng của phiên chính + agent/
 * reviewer ở worktree khác) có thể trùng DB → dùng chung hàng đợi BullMQ (`events-queue`, job), khoá `medusa_lock:*` →
 * sự kiện bị tiến trình khác lấy, lease khoá lệch. Nay `globalSetup` giành DB bằng `SET <khoá> <token> NX EX <ttl>` trên
 * DB 0 (khoá nằm ngoài DB được xoá), gia hạn định kỳ (interval `unref`), `globalTeardown` trả bằng Lua so token.
 * Tiến trình chết (SIGKILL, mất điện) → không ai gia hạn → TTL tự hết, DB về vùng trống.
 *
 * Vùng DB test: 1–12 trừ 7. DB 0 = dev, 7 = E2E (e2e/run.mjs xoá DB này), 13 = tải (scripts/load), 14 = perf,
 * 15 = diễn tập (scripts/ops) — các DB đó không bao giờ bị giành/xoá ở đây.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const TEST_REDIS_DBS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
/** DB chứa khoá giành DB — không thuộc vùng test nên FLUSHDB của lần chạy nào cũng không xoá khoá của lần chạy khác. */
export const LOCK_DB = 0;
export const LOCK_KEY_PREFIX = "x-shop:test-db-lock:";
export const DEFAULT_TTL_SEC = 120;
export const DEFAULT_RENEW_MS = 20_000;
export const DEFAULT_WAIT_MS = 300_000;
export const DEFAULT_POLL_MS = 1_000;

/** Gia hạn chỉ khi khoá còn đúng token của mình (không gia hạn hộ lần chạy khác đã giành lại sau khi TTL hết). */
export const RENEW_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], ARGV[2]) else return 0 end';
/** Trả chỉ khi khoá còn đúng token của mình (không xoá khoá lần chạy khác đang giữ). */
export const RELEASE_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

/** Phần tối thiểu của client ioredis mà việc giành/trả cần (test đơn vị thay bằng bản giả). */
export interface LeaseRedis {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface AcquireOptions {
  redis: LeaseRedis;
  /** Xoá sạch DB vừa giành (DB của chính lần chạy này — dữ liệu bỏ lại của lần chạy trước đã chết). */
  flushDb: (db: number) => Promise<void>;
  /** Thứ tự thử; mặc định TEST_REDIS_DBS. */
  dbs?: readonly number[];
  keyPrefix?: string;
  ttlSec?: number;
  renewMs?: number;
  /** Chờ tối đa khi mọi DB đều bận rồi lỗi "hết Redis DB test". */
  waitMs?: number;
  pollMs?: number;
  token?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RedisDbLease {
  readonly db: number;
  readonly token: string;
  readonly key: string;
  /** Interval gia hạn (đã `unref` — không giữ tiến trình sống). `null` sau khi trả. */
  readonly timer: NodeJS.Timeout | null;
  /** true khi một lần gia hạn thấy khoá đã thuộc lần chạy khác. */
  readonly lost: boolean;
  /** Gia hạn một lần; false = khoá không còn của mình và không giành lại được. */
  renew(): Promise<boolean>;
  /** Dừng gia hạn và xoá khoá nếu còn đúng token; true = đã xoá khoá của mình. Gọi lại lần hai → false. */
  release(): Promise<boolean>;
}

export class RedisDbExhaustedError extends Error {
  constructor(dbs: readonly number[], waitedMs: number) {
    super(
      `hết Redis DB test: mọi DB ${dbs.join(",")} đều đang bị lần chạy khác giữ sau ${waitedMs} ms chờ ` +
        `(khoá ${LOCK_KEY_PREFIX}<n> ở DB ${LOCK_DB}; lần chạy đã chết tự nhả sau TTL). Chờ lần chạy khác xong, ` +
        "hoặc tăng XS_TEST_REDIS_DB_WAIT_MS.",
    );
    this.name = "RedisDbExhaustedError";
  }
}

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`${name} phải là số nguyên dương (nhận ${v})`);
}

export function newLeaseToken(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

export async function acquireRedisDb(opts: AcquireOptions): Promise<RedisDbLease> {
  const dbs = opts.dbs ?? TEST_REDIS_DBS;
  const keyPrefix = opts.keyPrefix ?? LOCK_KEY_PREFIX;
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const renewMs = opts.renewMs ?? DEFAULT_RENEW_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const token = opts.token ?? newLeaseToken();

  if (dbs.length === 0) throw new TypeError("danh sách Redis DB test rỗng");
  for (const db of dbs) {
    if (!Number.isSafeInteger(db) || db < 0 || db === LOCK_DB) {
      throw new TypeError(`Redis DB test không hợp lệ: ${db} (số nguyên ≥ 1, khác DB khoá ${LOCK_DB})`);
    }
  }
  assertPositiveInt("ttlSec", ttlSec);
  assertPositiveInt("renewMs", renewMs);
  assertPositiveInt("pollMs", pollMs);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0)
    throw new TypeError(`waitMs phải là số nguyên ≥ 0 (nhận ${waitMs})`);
  // Ít nhất hai lần gia hạn trong một TTL — trễ một nhịp (event loop bận) không làm mất khoá.
  if (renewMs * 2 > ttlSec * 1000) throw new TypeError(`renewMs (${renewMs}) phải ≤ nửa TTL (${ttlSec} s)`);

  const started = now();
  for (;;) {
    for (const db of dbs) {
      const key = `${keyPrefix}${db}`;
      if ((await opts.redis.set(key, token, "EX", ttlSec, "NX")) !== "OK") continue;
      try {
        await opts.flushDb(db);
      } catch (err) {
        await opts.redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
        throw err;
      }
      return startLease({ redis: opts.redis, db, key, token, ttlSec, renewMs, log });
    }
    const waited = now() - started;
    if (waited >= waitMs) throw new RedisDbExhaustedError(dbs, waited);
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

function startLease(p: {
  redis: LeaseRedis;
  db: number;
  key: string;
  token: string;
  ttlSec: number;
  renewMs: number;
  log: (msg: string) => void;
}): RedisDbLease {
  let released = false;
  let lost = false;
  let timer: NodeJS.Timeout | null = null;

  const renew = async (): Promise<boolean> => {
    if (released) return false;
    if (Number(await p.redis.eval(RENEW_SCRIPT, 1, p.key, p.token, p.ttlSec)) === 1) return true;
    // Khoá đã hết hạn/bị xoá (vd DB 0 bị FLUSHDB) → giành lại nếu chưa ai lấy; đã có chủ khác → báo to.
    if ((await p.redis.set(p.key, p.token, "EX", p.ttlSec, "NX")) === "OK") {
      p.log(
        `khoá Redis DB ${p.db} đã mất (TTL hết hoặc bị xoá) — đã giành lại; lần chạy khác có thể đã chạm DB này`,
      );
      return true;
    }
    if (!lost)
      p.log(`MẤT khoá Redis DB ${p.db}: lần chạy khác đang giữ — test của hai lần chạy có thể giẫm nhau`);
    lost = true;
    return false;
  };

  timer = setInterval(() => {
    renew().catch((err: unknown) => p.log(`gia hạn khoá Redis DB ${p.db} lỗi: ${String(err)}`));
  }, p.renewMs);
  timer.unref();

  return {
    db: p.db,
    token: p.token,
    key: p.key,
    get timer() {
      return timer;
    },
    get lost() {
      return lost;
    },
    renew,
    async release() {
      if (released) return false;
      released = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      return Number(await p.redis.eval(RELEASE_SCRIPT, 1, p.key, p.token)) === 1;
    },
  };
}

/** DB index ghi trong REDIS_URL (`redis://h:6379/3` → 3); không ghi (`""`/`"/"`) → null. */
export function redisUrlDb(url: URL): number | null {
  const path = url.pathname;
  if (path === "" || path === "/") return null;
  const m = /^\/(\d{1,2})$/.exec(path);
  if (m === null) throw new TypeError(`REDIS_URL có đường dẫn không phải DB index: "${path}"`);
  return Number(m[1]);
}

export function withRedisDb(url: URL | string, db: number): string {
  const u = new URL(url.toString());
  u.pathname = `/${db}`;
  return u.toString();
}
