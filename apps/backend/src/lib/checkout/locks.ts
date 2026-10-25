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
 *  - quá hạn chờ → trả lại mọi khóa đã lấy rồi báo `BUSY_RETRY`;
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
}

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
}

const leases = new Map<string, Lease>();

function startRenewal(locking: LockingLike, ownerId: string, keys: string[], ttlSeconds: number): void {
  let lease = leases.get(ownerId);
  if (!lease) {
    lease = { keys: new Set(), ttlSeconds, timer: null };
    leases.set(ownerId, lease);
  }
  for (const k of keys) lease.keys.add(k);
  if (lease.timer) return;
  const current = lease;
  current.timer = setInterval(
    () => {
      for (const key of current.keys) {
        // Cùng ownerId → provider đặt lại TTL (gia hạn). Lỗi tạm (mạng) thì lần sau thử lại; khóa vẫn tự hết hạn.
        locking.acquire(key, { ownerId, expire: current.ttlSeconds }).catch(() => undefined);
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
  const held: string[] = [];
  try {
    for (const key of sorted) {
      let delay = 10;
      for (;;) {
        try {
          await locking.acquire(key, { ownerId: opts.ownerId, expire: opts.ttlSeconds });
          held.push(key);
          break;
        } catch (e) {
          if (!isBusyError(e)) throw e;
          if (Date.now() >= deadline) {
            throw new CheckoutError("BUSY_RETRY", undefined, { detail: { lock_scope: opts.scope } });
          }
          await sleep(Math.min(delay * (0.5 + Math.random()), Math.max(1, deadline - Date.now())));
          delay = Math.min(delay * 2, 80);
        }
      }
    }
  } catch (e) {
    if (held.length > 0) await locking.release(held, { ownerId: opts.ownerId }).catch(() => false);
    throw e;
  }
  if (held.length > 0) startRenewal(locking, opts.ownerId, held, opts.ttlSeconds);
  return held;
}

/** Nhả khóa của chủ (chỉ khóa do chính ownerId giữ). `keys = null` → nhả mọi khóa đang gia hạn của chủ. */
export async function releaseOwned(
  locking: LockingLike,
  ownerId: string,
  keys: readonly string[] | null,
): Promise<void> {
  const lease = leases.get(ownerId);
  const toRelease = keys ?? (lease ? [...lease.keys] : []);
  stopRenewal(ownerId, keys);
  if (toRelease.length > 0) await locking.release([...toRelease], { ownerId });
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
