import { writeSync } from "node:fs";

/**
 * Tắt êm (ARC-RES-009, BE-REL-004, T-094).
 *
 * Medusa 2.22.1 `medusa start` (@medusajs/medusa/dist/commands/start.js) tự gắn `SIGTERM`/`SIGINT` → `server.shutdown()`
 * (GracefulShutdownServer: `server.close()` NGAY + huỷ socket rảnh, chờ request dở KHÔNG có hạn) → `shutdown()` của loader
 * (onApplicationPrepareShutdown: BullMQ `worker.close()` chờ job đang chạy xong, job chưa nhận vẫn ở hàng đợi Redis;
 * onApplicationShutdown: đóng queue/kho Redis của module; `container.dispose()`; huỷ pool Postgres; ngắt client Redis
 * của express-session) → `process.exit(0)`. Thiếu hai thứ:
 *  1. Không có pha readiness lỗi: listener đóng ngay khi nhận SIGTERM, trong khi bộ cân bằng tải còn gửi request tới
 *     (Kubernetes gỡ endpoint song song với SIGTERM) → kết nối bị từ chối.
 *  2. Không có trần: request/job treo → tiến trình chờ tới khi nền tảng SIGKILL (mất cả phần dọn dẹp).
 *
 * Cách làm (không vá Medusa): `installGracefulShutdown()` chạy ở `instrumentation.ts` (Medusa gọi `register()` TRƯỚC khi
 * gắn handler tín hiệu của nó). Handler SIGTERM/SIGINT gắn SAU đó (của Medusa) bị gỡ ngay trong microtask (sự kiện
 * `newListener` của EventEmitter — API công khai) và giữ lại; khi có tín hiệu:
 *  a. `draining = true` → `GET /x/readyz` trả 503 (bộ cân bằng tải ngừng gửi), request vẫn được phục vụ;
 *  b. chờ `drainDelayMs` để bộ cân bằng tải kịp thấy readiness lỗi;
 *  c. gọi handler đã giữ của Medusa (đóng listener, chờ request dở, đóng job/pool/Redis, thoát 0);
 *  d. trần cứng `timeoutMs` (đặt < grace period của nền tảng, mặc định 25 s < 30 s của Kubernetes) tính từ tín hiệu:
 *     quá hạn → log lỗi + thoát mã 1 (không im lặng chờ SIGKILL).
 * Tín hiệu lặp lại trong lúc tắt chỉ ghi log.
 */

export type ShutdownSignal = "SIGTERM" | "SIGINT";
export const SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = ["SIGTERM", "SIGINT"];

type Listener = (...args: unknown[]) => void;

export interface SignalProcess {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

export interface ShutdownOptions {
  /** Thời gian giữ readiness 503 mà vẫn phục vụ trước khi đóng listener. */
  drainDelayMs: number;
  /** Trần toàn bộ quá trình tắt, tính từ lúc nhận tín hiệu. */
  timeoutMs: number;
}

export interface ShutdownDeps {
  proc?: SignalProcess;
  exit?: (code: number) => void;
  /** Ghi một dòng log JSON (mặc định: ghi đồng bộ fd 1). */
  write?: (line: string) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
}

export interface ShutdownState {
  draining: boolean;
  signal: ShutdownSignal | null;
}

const STATE = Symbol.for("x-shop.lifecycle.shutdown-state");
const INSTALLED = Symbol.for("x-shop.lifecycle.shutdown-installed");

/**
 * Trạng thái dùng chung theo tiến trình: `instrumentation.ts` và route readyz có thể được nạp qua hai đường module khác
 * nhau (ESM/CJS, bản build) → giữ trên `globalThis` bằng Symbol.for, không phải biến module.
 */
export function shutdownState(): ShutdownState {
  const g = globalThis as unknown as Record<symbol, ShutdownState | undefined>;
  let s = g[STATE];
  if (s === undefined) {
    s = { draining: false, signal: null };
    g[STATE] = s;
  }
  return s;
}

/** Route readiness hỏi hàm này: true → trả 503 ngay, không probe phụ thuộc. */
export function isDraining(): boolean {
  return shutdownState().draining;
}

/** Chỉ dùng trong test: đưa trạng thái về ban đầu. */
export function resetShutdownStateForTest(): void {
  const s = shutdownState();
  s.draining = false;
  s.signal = null;
  delete (process as unknown as Record<symbol, unknown>)[INSTALLED];
}

function defaultWrite(line: string): void {
  try {
    writeSync(1, line + "\n");
  } catch {
    // stdout đóng — vẫn tiếp tục tắt.
  }
}

export interface ShutdownController {
  /** Handler tín hiệu đã gỡ khỏi tiến trình (của Medusa) — gọi ở bước (c). */
  readonly deferred: ReadonlyArray<{ signal: ShutdownSignal; listener: Listener }>;
  /** Bắt đầu tắt (idempotent) — cũng là handler gắn cho SIGTERM/SIGINT. */
  begin(signal: ShutdownSignal): Promise<void>;
}

export function createShutdownController(opts: ShutdownOptions, deps: ShutdownDeps = {}): ShutdownController {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const write = deps.write ?? defaultWrite;
  const now = deps.now ?? (() => new Date());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const deferred: Array<{ signal: ShutdownSignal; listener: Listener }> = [];
  const state = shutdownState();
  let started: Promise<void> | null = null;

  const log = (level: "info" | "warn" | "error", message: string, extra: Record<string, unknown> = {}) =>
    write(
      JSON.stringify({
        timestamp: now().toISOString(),
        level,
        service: "x-shop-backend",
        event: "shutdown",
        message,
        ...extra,
      }),
    );

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) resolve();
      else setTimer(resolve, ms);
    });

  async function run(signal: ShutdownSignal): Promise<void> {
    state.draining = true;
    state.signal = signal;
    log("info", "Nhận tín hiệu — readiness 503, vẫn phục vụ request đang tới", {
      signal,
      drain_delay_ms: opts.drainDelayMs,
      timeout_ms: opts.timeoutMs,
    });
    const hard = setTimer(() => {
      log("error", "Quá trần tắt êm — thoát cưỡng bức", { signal, timeout_ms: opts.timeoutMs });
      exit(1);
    }, opts.timeoutMs);
    // Không giữ tiến trình sống chỉ vì bộ hẹn giờ trần.
    hard.unref?.();
    await sleep(opts.drainDelayMs);
    const handlers = deferred.filter((d) => d.signal === signal);
    if (handlers.length === 0) {
      // Không chạy dưới `medusa start` (không có handler để chuyển giao) → không có gì để dọn, thoát sạch.
      log("warn", "Không có handler tắt của Medusa — thoát 0", { signal });
      exit(0);
      return;
    }
    log("info", "Đóng listener, chờ request/job dở, đóng pool Postgres/Redis", { signal });
    for (const { listener } of handlers) {
      try {
        listener(signal);
      } catch (err) {
        log("error", "Handler tắt ném lỗi", {
          signal,
          "exception.type": err instanceof Error ? err.name : typeof err,
          "exception.message": err instanceof Error ? err.message : String(err),
        });
        exit(1);
        return;
      }
    }
  }

  return {
    deferred,
    begin(signal) {
      if (started !== null) {
        log("warn", "Tín hiệu lặp lại trong lúc tắt — bỏ qua", { signal });
        return started;
      }
      started = run(signal);
      return started;
    },
  };
}

/**
 * Cài tắt êm cho tiến trình (idempotent). Trả controller, hoặc null nếu đã cài. Phải gọi TRƯỚC khi Medusa gắn handler
 * tín hiệu (instrumentation `register()`).
 */
export function installGracefulShutdown(
  opts: ShutdownOptions,
  deps: ShutdownDeps = {},
): ShutdownController | null {
  const proc = deps.proc ?? (process as unknown as SignalProcess);
  const holder = proc as unknown as Record<symbol, boolean>;
  if (holder[INSTALLED] === true) return null;
  holder[INSTALLED] = true;
  const controller = createShutdownController(opts, deps);
  const ours = new Map<ShutdownSignal, Listener>();
  const deferred = controller.deferred as Array<{ signal: ShutdownSignal; listener: Listener }>;
  proc.on("newListener", (event: unknown, listener: unknown) => {
    if (typeof event !== "string" || typeof listener !== "function") return;
    const signal = SHUTDOWN_SIGNALS.find((s) => s === event);
    if (signal === undefined || ours.get(signal) === listener) return;
    // `newListener` phát TRƯỚC khi listener được thêm → gỡ ở microtask kế (tín hiệu chỉ tới qua vòng sự kiện, không
    // chen được vào giữa).
    queueMicrotask(() => {
      proc.removeListener(signal, listener as Listener);
      deferred.push({ signal, listener: listener as Listener });
    });
  });
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler: Listener = () => {
      void controller.begin(signal);
    };
    ours.set(signal, handler);
    proc.on(signal, handler);
  }
  return controller;
}
