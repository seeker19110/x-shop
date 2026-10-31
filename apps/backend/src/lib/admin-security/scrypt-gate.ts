import { AsyncLocalStorage } from "node:async_hooks";
import { secondsToMs } from "@x-shop/domain";

/**
 * Trần số phép scrypt đồng thời của provider `emailpass` (T-181, ADR-0006, review 🟠 DoS thread pool).
 *
 * `crypto.scrypt` chạy trên thread pool của libuv (mặc định 4 luồng) — cùng pool với `fs.*`, `dns.lookup`, `zlib`,
 * `crypto.pbkdf2/randomFill`… Ở logN 17 mỗi phép ~0,5 s và 128 MiB: vài lần đăng nhập dồn dập chiếm hết pool làm mọi I/O
 * khác của tiến trình (đọc file, phân giải DNS VNPAY/GHN, mở kết nối Postgres) chờ hàng giây. Rate limit theo IP/định danh
 * không chặn được nhiều IP cùng lúc.
 *
 * Mọi phép scrypt của bản bọc (kiểm mật khẩu, hash mồi, băm lại, đăng ký, đổi mật khẩu) đi qua MỘT semaphore chung mỗi
 * tiến trình: tối đa `max(1, UV_THREADPOOL_SIZE − 1)` phép chạy (luôn chừa ≥ 1 luồng cho I/O khi pool ≥ 2), hàng chờ có
 * trần và hạn chờ. Quá trần/quá hạn → `ScryptBusyError` ném NGAY (không chạy scrypt) — mọi nhánh (email có/không tồn tại)
 * cùng một kết quả, nên không lộ tài khoản. Lớp HTTP đổi lỗi này thành 503 `AUTH_BUSY` + `Retry-After` (xem
 * `markAuthBusy`/`isAuthBusy`): 503 thay vì 429 vì đây là quá tải máy chủ, không phải lỗi của người gửi — và rate limit
 * đăng nhập hoàn lại lượt cho 5xx (không phạt người dùng thật bị kẹt sau đợt dội), còn 4xx bị tính là lần sai.
 */

/** Lỗi khi semaphore scrypt đầy hàng chờ hoặc chờ quá hạn. */
export class ScryptBusyError extends Error {
  constructor(reason: "queue_full" | "timeout") {
    super(`scrypt busy: ${reason}`);
    this.name = "ScryptBusyError";
  }
}

export interface ConcurrencyGateOptions {
  /** Số việc chạy đồng thời tối đa (≥ 1). */
  max: number;
  /** Số việc chờ tối đa (≥ 0); vượt → từ chối ngay. */
  queueMax: number;
  /** Hạn chờ trong hàng (ms); quá → từ chối. */
  waitTimeoutMs: number;
}

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}

/** Semaphore đếm có hàng chờ FIFO, trần hàng chờ và hạn chờ. Slot luôn được trả kể cả khi việc ném lỗi. */
export class ConcurrencyGate {
  private active_ = 0;
  private readonly queue_: Waiter[] = [];

  constructor(readonly options: ConcurrencyGateOptions) {
    if (!Number.isInteger(options.max) || options.max < 1) throw new RangeError("max phải là số nguyên ≥ 1");
    if (!Number.isInteger(options.queueMax) || options.queueMax < 0)
      throw new RangeError("queueMax phải là số nguyên ≥ 0");
  }

  get active(): number {
    return this.active_;
  }

  get waiting(): number {
    return this.queue_.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire_();
    try {
      return await fn();
    } finally {
      this.release_();
    }
  }

  private acquire_(): Promise<void> {
    if (this.active_ < this.options.max) {
      this.active_ += 1;
      return Promise.resolve();
    }
    if (this.queue_.length >= this.options.queueMax) return Promise.reject(new ScryptBusyError("queue_full"));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.queue_.indexOf(waiter);
          if (i >= 0) this.queue_.splice(i, 1);
          reject(new ScryptBusyError("timeout"));
        }, this.options.waitTimeoutMs),
      };
      this.queue_.push(waiter);
    });
  }

  private release_(): void {
    const next = this.queue_.shift();
    // Chuyển slot thẳng cho người chờ kế tiếp (active giữ nguyên); không ai chờ → trả slot.
    if (next) next.grant();
    else this.active_ -= 1;
  }
}

/** Mặc định của libuv khi không đặt `UV_THREADPOOL_SIZE`. */
export const DEFAULT_UV_THREADPOOL_SIZE = 4;
/** Trần libuv cho `UV_THREADPOOL_SIZE`. */
const MAX_UV_THREADPOOL_SIZE = 1024;
/** Hàng chờ tối đa: 32 lần ≈ 32 × 0,5 s / 3 slot ≈ 5 s để xả — khớp hạn chờ. */
export const SCRYPT_QUEUE_MAX = 32;
export const SCRYPT_WAIT_TIMEOUT_MS = secondsToMs(5);
/** `Retry-After` (giây) của 503 AUTH_BUSY. */
export const AUTH_BUSY_RETRY_AFTER_SECONDS = 1;

/** Kích thước thread pool libuv của tiến trình: `UV_THREADPOOL_SIZE` hợp lệ (1–1024) hoặc mặc định 4. */
export function uvThreadpoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UV_THREADPOOL_SIZE;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_UV_THREADPOOL_SIZE;
  const n = Number(raw.trim());
  return n >= 1 && n <= MAX_UV_THREADPOOL_SIZE ? n : DEFAULT_UV_THREADPOOL_SIZE;
}

/** Số phép scrypt đồng thời: chừa một luồng cho I/O, tối thiểu 1. */
export function scryptConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, uvThreadpoolSize(env) - 1);
}

let shared: ConcurrencyGate | null = null;

/** Semaphore dùng chung của tiến trình cho mọi phép scrypt của provider `emailpass`. */
export function scryptGate(): ConcurrencyGate {
  shared ??= new ConcurrencyGate({
    max: scryptConcurrency(),
    queueMax: SCRYPT_QUEUE_MAX,
    waitTimeoutMs: SCRYPT_WAIT_TIMEOUT_MS,
  });
  return shared;
}

/**
 * CHỈ dùng trong test: thay semaphore dùng chung (vd hạn chờ lớn, cổng riêng từng ca để không rò trạng thái giữa ca);
 * `null` = lần gọi `scryptGate()` sau tạo lại bản mặc định. Trả bản đang dùng để test khôi phục.
 */
export function replaceScryptGateForTest(gate: ConcurrencyGate | null): ConcurrencyGate | null {
  const previous = shared;
  shared = gate;
  return previous;
}

/**
 * Cờ "đã từ chối vì scrypt bận" theo request. Auth Module của Medusa nuốt lỗi của provider thành `{ success: false }`
 * rồi route ném 401 (thông điệp có thể bị thay bằng "Authentication failed") — nên provider báo ngoài luồng qua
 * AsyncLocalStorage; middleware `/auth` mở ngữ cảnh, handler lỗi toàn cục đọc cờ để trả 503.
 */
const busyContext = new AsyncLocalStorage<{ busy: boolean }>();

/** Chạy phần còn lại của request trong ngữ cảnh cờ bận. */
export function withAuthBusyContext<T>(fn: () => T): T {
  return busyContext.run({ busy: false }, fn);
}

/** Đánh dấu request hiện tại bị từ chối vì scrypt bận (không có ngữ cảnh → bỏ qua). */
export function markAuthBusy(): void {
  const store = busyContext.getStore();
  if (store) store.busy = true;
}

/** Request hiện tại đã bị từ chối vì scrypt bận? */
export function isAuthBusy(): boolean {
  return busyContext.getStore()?.busy === true;
}

/** Middleware `/auth`: mở ngữ cảnh cờ bận cho phần còn lại của request (đặt trước middleware/handler /auth khác). */
export function authBusyContext(_req: unknown, _res: unknown, next: () => void): void {
  withAuthBusyContext(next);
}
