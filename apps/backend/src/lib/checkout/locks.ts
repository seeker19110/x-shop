import { randomUUID } from "node:crypto";
import { CheckoutError } from "./errors";

/**
 * Khóa phân tán cho checkout trên Locking Module của Medusa (provider Redis) — đặc tả §6.2 "khóa theo tài nguyên, thứ
 * tự ổn định, có thời hạn, gia hạn và phục hồi được".
 *
 * Vì sao không dùng thẳng `acquireLockStep`/`locking.execute(keys[])`: provider locking-redis 2.22.1 lấy NHIỀU khóa
 * SONG SONG (`Promise.all` từng key trong `acquire_`) nên thứ tự tăng dần không được bảo đảm (hai checkout giữ chéo
 * nhau → chờ tới timeout), và khi một key thất bại các key đã lấy không được trả lại (rò khóa tới hết hạn). Ở đây:
 *  - lấy TUẦN TỰ theo thứ tự tăng dần (thứ tự toàn cục: `cart:` < `inventory_item:` < `promotion:` do caller gọi theo
 *    lớp, trong mỗi lớp sắp tăng dần) → không deadlock;
 *  - quá hạn chờ (khóa đang bị giữ) → trả lại mọi khóa đã lấy rồi báo `BUSY_RETRY` (409);
 *  - hạ tầng khóa hỏng (Redis mất kết nối/không trả lời — mọi lỗi KHÁC "khóa đang bận", hoặc một lời gọi quá
 *    `callTimeoutMs`) → trả lại khóa đã lấy rồi báo `LOCK_UNAVAILABLE` (503, đặc tả §13.2). KHÔNG có đường lùi khóa
 *    in-memory: một tiến trình không thể tự bảo đảm loại trừ giữa nhiều instance → thà dừng bán còn hơn bán vượt tồn;
 *  - mỗi khóa có TTL (tiến trình chết → tự nhả) và được gia hạn mỗi 1/3 TTL khi chủ còn sống (acquire lại cùng
 *    ownerId = gia hạn trong provider).
 * Khóa native của Medusa dùng id thô (`<cart_id>`, `<inventory_item_id>`); khóa ở đây có tiền tố nên không tự khóa chéo
 * với `createReservationsStep` (nó tự khóa id thô quanh việc ghi reserved_quantity).
 */
export interface LockingLike {
  acquire(keys: string | string[], args?: { ownerId?: string | null; expire?: number }): Promise<void>;
  release(keys: string | string[], args?: { ownerId?: string | null }): Promise<boolean>;
}

export interface AcquireOptions {
  ownerId: string;
  waitMs: number;
  ttlSeconds: number;
  /** Tên nhóm khóa để báo lỗi (cart|inventory|promotion). */
  scope: string;
  /** Hạn một lời gọi tới provider (mặc định `LOCK_CALL_TIMEOUT_MS`); quá hạn = hạ tầng khóa không trả lời. */
  callTimeoutMs?: number;
}

/**
 * Hạn mỗi lời gọi acquire/release. Lệnh khóa là một script Lua O(1) — Redis khỏe trả trong vài ms. ioredis mặc định xếp
 * lệnh chờ khi mất kết nối và chỉ báo lỗi sau ~20 lần kết nối lại (~10 giây) → không để khách treo theo nó.
 */
export const LOCK_CALL_TIMEOUT_MS = 3_000;

class LockCallTimeout extends Error {
  override readonly name = "LockCallTimeout";
}

/**
 * Chờ `p` tối đa `ms`; quá hạn → ném LockCallTimeout (lời gọi gốc vẫn chạy tiếp ở nền — caller tự dọn). Dùng chung cho
 * mọi lời gọi tới Locking Module (checkout, read model catalog, seed) để lệnh Redis treo không kẹt tiến trình.
 */
export async function withLockCallTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LockCallTimeout(`lock call timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const lockUnavailable = (scope: string, cause: unknown) =>
  new CheckoutError("LOCK_UNAVAILABLE", undefined, { detail: { lock_scope: scope }, cause });

const isBusyError = (e: unknown): boolean =>
  e instanceof Error ? /Failed to acquire lock|Timed-out acquiring lock/.test(e.message) : false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bỏ trùng + sắp tăng dần theo mã ký tự (ổn định, không phụ thuộc locale). */
export function sortLockKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface Lease {
  keys: Set<string>;
  ttlSeconds: number;
  timer: ReturnType<typeof setInterval> | null;
  /**
   * Một lần gia hạn thấy khóa đã thuộc chủ KHÁC (lease hết hạn trong lúc Redis không trả lời và bị người khác lấy) —
   * vùng găng không còn độc quyền. Chỉ ghi nhận; `withOwnedLock({ failOnLeaseLoss })` đọc để báo lỗi như
   * `locking.execute` native. Không phát hiện được ca khóa hết hạn rồi được chính chủ SET lại khi chưa ai lấy.
   */
  lost: boolean;
}

const leases = new Map<string, Lease>();

function startRenewal(locking: LockingLike, ownerId: string, keys: string[], ttlSeconds: number): void {
  let lease = leases.get(ownerId);
  if (!lease) {
    lease = { keys: new Set(), ttlSeconds, timer: null, lost: false };
    leases.set(ownerId, lease);
  }
  for (const k of keys) lease.keys.add(k);
  if (lease.timer) return;
  const current = lease;
  current.timer = setInterval(
    () => {
      for (const key of current.keys) {
        // Cùng ownerId → provider đặt lại TTL (gia hạn). Lỗi tạm (mạng) thì lần sau thử lại; khóa vẫn tự hết hạn.
        // "Đang bận" = khóa đã về tay chủ khác → mất lease (ghi nhận, không tự lấy lại).
        locking.acquire(key, { ownerId, expire: current.ttlSeconds }).catch((e: unknown) => {
          if (isBusyError(e)) current.lost = true;
        });
      }
    },
    Math.max(250, Math.floor((ttlSeconds * 1000) / 3)),
  );
  current.timer.unref?.();
}

function stopRenewal(ownerId: string, keys: readonly string[] | null): void {
  const lease = leases.get(ownerId);
  if (!lease) return;
  if (keys === null) lease.keys.clear();
  else for (const k of keys) lease.keys.delete(k);
  if (lease.keys.size === 0) {
    if (lease.timer) clearInterval(lease.timer);
    leases.delete(ownerId);
  }
}

/** Lấy khóa tuần tự theo thứ tự tăng dần; trả về danh sách đã giữ (đã sắp). Quá hạn → nhả hết, ném BUSY_RETRY. */
export async function acquireOrdered(
  locking: LockingLike,
  keys: Iterable<string>,
  opts: AcquireOptions,
): Promise<string[]> {
  const sorted = sortLockKeys(keys);
  const deadline = Date.now() + opts.waitMs;
  const callTimeout = opts.callTimeoutMs ?? LOCK_CALL_TIMEOUT_MS;
  const held: string[] = [];
  try {
    for (const key of sorted) {
      let delay = 10;
      for (;;) {
        try {
          const call = locking.acquire(key, { ownerId: opts.ownerId, expire: opts.ttlSeconds });
          try {
            await withLockCallTimeout(call, callTimeout);
          } catch (e) {
            if (e instanceof LockCallTimeout) {
              // Lệnh có thể đã nằm trong hàng đợi ioredis và chạy khi Redis trở lại → trả khóa ngay khi nó xong, không
              // để `key` bị giữ tới hết TTL bởi một checkout đã báo lỗi cho khách.
              call.then(
                () => locking.release(key, { ownerId: opts.ownerId }).catch(() => false),
                () => undefined,
              );
            }
            throw e;
          }
          held.push(key);
          break;
        } catch (e) {
          if (!isBusyError(e)) throw lockUnavailable(opts.scope, e);
          if (Date.now() >= deadline) {
            throw new CheckoutError("BUSY_RETRY", undefined, { detail: { lock_scope: opts.scope } });
          }
          await sleep(Math.min(delay * (0.5 + Math.random()), Math.max(1, deadline - Date.now())));
          delay = Math.min(delay * 2, 80);
        }
      }
    }
  } catch (e) {
    // Trả khóa đã lấy — có hạn chờ: Redis đang mất thì không treo request; khóa vẫn tự hết hạn theo TTL.
    if (held.length > 0) {
      await withLockCallTimeout(locking.release(held, { ownerId: opts.ownerId }), callTimeout).catch(
        () => false,
      );
    }
    throw e;
  }
  if (held.length > 0) startRenewal(locking, opts.ownerId, held, opts.ttlSeconds);
  return held;
}

/**
 * Nhả khóa của chủ (chỉ khóa do chính ownerId giữ). `keys = null` → nhả mọi khóa đang gia hạn của chủ. Ngừng gia hạn
 * TRƯỚC khi gọi provider: nhả lỗi (Redis mất) thì khóa vẫn tự hết hạn sau TTL. Lỗi/quá hạn → `LOCK_UNAVAILABLE`.
 */
export async function releaseOwned(
  locking: LockingLike,
  ownerId: string,
  keys: readonly string[] | null,
  callTimeoutMs: number = LOCK_CALL_TIMEOUT_MS,
): Promise<void> {
  const lease = leases.get(ownerId);
  const toRelease = keys ?? (lease ? [...lease.keys] : []);
  stopRenewal(ownerId, keys);
  if (toRelease.length === 0) return;
  try {
    await withLockCallTimeout(locking.release([...toRelease], { ownerId }), callTimeoutMs);
  } catch (e) {
    throw lockUnavailable("release", e);
  }
}

export interface OwnedLockOptions {
  waitMs: number;
  ttlSeconds: number;
  scope: string;
  callTimeoutMs?: number;
  /** Tiền tố ownerId (dễ đọc khi soi Redis/log), mặc định `lock`. */
  ownerPrefix?: string;
  /**
   * Như `locking.execute` native: nếu trong lúc `fn` chạy một lần gia hạn thấy khóa đã về tay chủ khác thì báo
   * `LOCK_UNAVAILABLE` (detail `lease_lost`) thay vì trả kết quả như thể đã giữ khóa suốt. `fn` KHÔNG bị cắt giữa chừng
   * (phần đã ghi vẫn còn) — chỉ dùng cho tác vụ gọi lại được an toàn (idempotent).
   */
  failOnLeaseLoss?: boolean;
  onReleaseError?: (e: unknown) => void;
}

/**
 * Chạy `fn` dưới khóa `key` (hoặc nhiều khóa — lấy tuần tự tăng dần) của Locking Module với mọi lời gọi có hạn
 * (acquire/gia hạn/release) — thay cho `locking.execute` không hạn. Chờ khóa bận tối đa `waitMs` (quá → BUSY_RETRY);
 * Redis lỗi/không trả lời trong `callTimeoutMs` → LOCK_UNAVAILABLE (503) và KHÔNG chạy `fn`. Hạn chỉ áp cho bước
 * giành/nhả khóa, KHÔNG cắt `fn` đang chạy (lease `ttlSeconds` được gia hạn nền mỗi 1/3 TTL tới khi xong — tác vụ dài
 * như import CSV không cần TTL dài; tiến trình chết thì khóa tự nhả sau ≤ TTL). Nhả lỗi/quá hạn không làm hỏng kết quả
 * của `fn` — khóa tự hết hạn theo TTL; lỗi được báo qua `onReleaseError`.
 */
export async function withOwnedLock<T>(
  locking: LockingLike,
  key: string | readonly string[],
  opts: OwnedLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const ownerId = `${opts.ownerPrefix ?? "lock"}:${randomUUID()}`;
  const keys = typeof key === "string" ? [key] : [...key];
  const held = await acquireOrdered(locking, keys, {
    ownerId,
    waitMs: opts.waitMs,
    ttlSeconds: opts.ttlSeconds,
    scope: opts.scope,
    callTimeoutMs: opts.callTimeoutMs,
  });
  try {
    const result = await fn();
    if (opts.failOnLeaseLoss && leases.get(ownerId)?.lost) {
      throw new CheckoutError("LOCK_UNAVAILABLE", undefined, {
        detail: { lock_scope: opts.scope, lease_lost: true },
        cause: new Error(`lease lost for ${held.join(", ")} while the job was running`),
      });
    }
    return result;
  } finally {
    // Đã mất lease → khóa không còn của mình; release theo ownerId vẫn an toàn (Lua chỉ xoá khi đúng chủ).
    const err = await releaseOwnedQuietly(locking, ownerId, held, opts.callTimeoutMs);
    if (err) opts.onReleaseError?.(err);
  }
}

/**
 * Lấy một khóa KHÔNG chờ, KHÔNG gia hạn, tự hết sau `expireSeconds` — dùng làm giới hạn tần suất phân tán (vd nút
 * "Kiểm tra lại" 1 lần / 10 giây). `true` = vừa lấy được; `false` = đang bị giữ (đã gọi trong cửa sổ). Lời gọi có hạn
 * `callTimeoutMs`: Redis lỗi/không trả lời → LOCK_UNAVAILABLE (503) — KHÔNG coi là "đang bận" (khách không bị báo 429
 * sai, cũng không bỏ qua giới hạn). Lệnh tới muộn sau khi quá hạn chỉ giữ khóa tới hết `expireSeconds`.
 */
export async function tryAcquireExpiring(
  locking: LockingLike,
  key: string,
  opts: { expireSeconds: number; scope: string; ownerId?: string; callTimeoutMs?: number },
): Promise<boolean> {
  try {
    await withLockCallTimeout(
      locking.acquire(key, { ownerId: opts.ownerId ?? randomUUID(), expire: opts.expireSeconds }),
      opts.callTimeoutMs ?? LOCK_CALL_TIMEOUT_MS,
    );
    return true;
  } catch (e) {
    if (isBusyError(e)) return false;
    throw lockUnavailable(opts.scope, e);
  }
}

/**
 * Nhả khóa của chủ sau vùng găng mà KHÔNG làm đổi kết quả nghiệp vụ đã xong (hoặc che lỗi gốc của vùng găng): lỗi/quá
 * hạn chỉ ghi cảnh báo — khóa đã ngừng gia hạn và tự hết sau TTL.
 */
export async function releaseOwnedOrWarn(
  locking: LockingLike,
  ownerId: string,
  logger: { warn(message: string): unknown },
  label: string,
): Promise<void> {
  const err = await releaseOwnedQuietly(locking, ownerId, null);
  if (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    logger.warn(`[${label}] Nhả khóa lỗi/quá hạn (khóa tự hết theo TTL): ${cause}`);
  }
}

/**
 * Như `releaseOwned` nhưng không bao giờ ném — cho đường bù trừ và bước nhả sau khi đơn đã chốt: lỗi nhả khóa không được
 * kéo đổ một giao dịch đã đúng (khóa tự hết hạn theo TTL). Trả lỗi (nếu có) để caller ghi log.
 */
export async function releaseOwnedQuietly(
  locking: LockingLike,
  ownerId: string,
  keys: readonly string[] | null,
  callTimeoutMs: number = LOCK_CALL_TIMEOUT_MS,
): Promise<unknown> {
  try {
    await releaseOwned(locking, ownerId, keys, callTimeoutMs);
    return null;
  } catch (e) {
    return e;
  }
}

/** Lỗi hạ tầng khóa ném ra từ đây — có `cause` gốc để log phía server. */
export function isLockUnavailable(e: unknown): boolean {
  return e instanceof CheckoutError && e.code === "LOCK_UNAVAILABLE";
}

/** Số chủ đang có khóa được gia hạn — chỉ để test/giám sát rò khóa. */
export function activeLeaseCount(): number {
  return leases.size;
}

export const lockKeys = {
  cart: (cartId: string) => `cart:${cartId}`,
  inventoryItem: (inventoryItemId: string) => `inventory_item:${inventoryItemId}`,
  promotion: (code: string) => `promotion:${code}`,
  /** Khóa trạng thái đơn: IPN, querydr, hết hạn, hủy (S-006 — chỉ một nhánh thắng). */
  order: (orderId: string) => `order:${orderId}`,
} as const;
