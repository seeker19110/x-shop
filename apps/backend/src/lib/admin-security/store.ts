import Redis from "ioredis";
import { redisRequestOptions } from "../infra/timeouts";
import { isNonEmpty } from "@x-shop/domain";

/**
 * Kho khóa–giá trị có TTL cho trạng thái bảo mật dùng chung giữa các instance (nhàn rỗi phiên, bộ đếm rate limit).
 * Có REDIS_URL (bắt buộc ở production) → Redis; không có (dev/test đơn tiến trình) → bộ nhớ trong tiến trình.
 */
export interface SecurityStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Tăng bộ đếm; lần đầu đặt TTL (cửa sổ cố định). Trả giá trị sau khi tăng. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /**
   * Tăng `key` (lần đầu đặt TTL) và đọc `peekKey` trong CÙNG một thao tác nguyên tử (Redis Lua) — bộ đếm cửa sổ hiện tại +
   * cửa sổ trước cho rate limit cửa sổ trượt (T-055). Trả `{ current: sau khi tăng, previous: 0 nếu không có }`.
   * `cap` (T-143, D-085): chỉ tăng khi giá trị hiện tại < `cap` — bộ đếm không vượt `cap`, loạt request dồn dập không kéo
   * dài thời gian bị chặn.
   */
  incrPeek(
    key: string,
    ttlSeconds: number,
    peekKey: string,
    cap?: number,
  ): Promise<{ current: number; previous: number }>;
  /** Giảm bộ đếm (không xuống dưới 0). */
  decr(key: string): Promise<void>;
  del(key: string): Promise<void>;
  ttl(key: string): Promise<number>;
  /** Kiểm kho trả lời được (readiness, T-079): Redis `PING`; bộ nhớ → luôn được. Lỗi kết nối → reject. */
  ping(): Promise<void>;
  /** Đóng kết nối (khi ứng dụng tắt). */
  close(): Promise<void>;
}

/**
 * `XS_SECURITY_KEY_NAMESPACE` (tùy chọn) tách khóa giữa các môi trường dùng chung một Redis — test tích hợp đặt giá trị
 * riêng mỗi lần chạy để bộ đếm rate limit (cửa sổ 15 phút) của lần/suite trước không rò sang lần sau.
 */
const NAMESPACE = process.env.XS_SECURITY_KEY_NAMESPACE?.trim();
export const KEY_PREFIX = isNonEmpty(NAMESPACE) ? `xs:sec:${NAMESPACE}:` : "xs:sec:";

/**
 * KEYS[1] = bộ đếm cửa sổ hiện tại, KEYS[2] = cửa sổ trước; ARGV[1] = TTL (giây), ARGV[2] = trần. Tăng (và đặt TTL lần
 * đầu) chỉ khi còn dưới trần; trả {hiện tại, trước}. Một script = nguyên tử (thay MULTI vì có điều kiện).
 */
const INCR_PEEK_CAPPED = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c < tonumber(ARGV[2]) then
  c = redis.call('INCR', KEYS[1])
  if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
end
local p = tonumber(redis.call('GET', KEYS[2]) or '0')
return {c, p}
`;

class RedisStore implements SecurityStore {
  constructor(private readonly redis: Redis) {}
  async get(key: string) {
    return this.redis.get(KEY_PREFIX + key);
  }
  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(KEY_PREFIX + key, value, "EX", ttlSeconds);
  }
  async incr(key: string, ttlSeconds: number) {
    const k = KEY_PREFIX + key;
    const [[, n]] = (await this.redis.multi().incr(k).expire(k, ttlSeconds, "NX").exec()) as [
      [Error | null, number],
    ];
    return n;
  }
  async incrPeek(key: string, ttlSeconds: number, peekKey: string, cap: number = Number.MAX_SAFE_INTEGER) {
    const res = (await this.redis.eval(
      INCR_PEEK_CAPPED,
      2,
      KEY_PREFIX + key,
      KEY_PREFIX + peekKey,
      String(ttlSeconds),
      String(cap),
    )) as [number, number];
    return { current: Number(res[0]), previous: Number(res[1]) || 0 };
  }
  async decr(key: string) {
    const k = KEY_PREFIX + key;
    const n = await this.redis.decr(k);
    if (n <= 0) await this.redis.del(k);
  }
  async del(key: string) {
    await this.redis.del(KEY_PREFIX + key);
  }
  async ttl(key: string) {
    return this.redis.ttl(KEY_PREFIX + key);
  }
  async ping() {
    await this.redis.ping();
  }
  async close() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

export class MemoryStore implements SecurityStore {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();
  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async incr(key: string, ttlSeconds: number) {
    const e = this.live(key);
    const n = (e ? Number(e.value) : 0) + 1;
    this.data.set(key, { value: String(n), expiresAt: e?.expiresAt ?? Date.now() + ttlSeconds * 1000 });
    return n;
  }
  async incrPeek(key: string, ttlSeconds: number, peekKey: string, cap: number = Number.MAX_SAFE_INTEGER) {
    const now = Number(this.live(key)?.value ?? 0) || 0;
    const current = now < cap ? await this.incr(key, ttlSeconds) : now;
    return { current, previous: Number(this.live(peekKey)?.value ?? 0) || 0 };
  }
  async decr(key: string) {
    const e = this.live(key);
    if (!e) return;
    const n = Number(e.value) - 1;
    if (n <= 0) this.data.delete(key);
    else e.value = String(n);
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async ttl(key: string) {
    const e = this.live(key);
    return e ? Math.ceil((e.expiresAt - Date.now()) / 1000) : -2;
  }
  async ping() {}
  async close() {
    this.data.clear();
  }
}

/**
 * Tạo kho theo REDIS_URL. Chủ sở hữu là module `xRbac` (một kho / ứng dụng, đóng ở onApplicationShutdown) — không dùng
 * biến toàn cục: kết nối mồ côi giữ cả đồ thị module sống (rò bộ nhớ khi chạy nhiều ứng dụng trong một tiến trình test).
 */
export function createSecurityStore(redisUrl = process.env.REDIS_URL?.trim()): SecurityStore {
  return isNonEmpty(redisUrl)
    ? new RedisStore(
        new Redis(redisUrl, {
          maxRetriesPerRequest: 2,
          connectionName: "x-shop-admin-security",
          // Timeout tường minh (T-092): mở kết nối + mỗi lệnh.
          ...redisRequestOptions(),
        }),
      )
    : new MemoryStore();
}
