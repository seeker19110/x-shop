import { EventEmitter } from "node:events";
import { parseEnv } from "../../env";
import {
  createShutdownController,
  installGracefulShutdown,
  isDraining,
  resetShutdownStateForTest,
  shutdownState,
  type SignalProcess,
} from "../shutdown";

/**
 * T-094 (BE-REL-004, ARC-RES-009): điều phối tắt êm — pha readiness 503, chuyển giao handler của Medusa, trần cứng.
 * Tiến trình Medusa thật: integration-tests/http/shutdown.spec.ts.
 */

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Harness {
  proc: EventEmitter;
  exits: number[];
  lines: Array<Record<string, unknown>>;
  timers: Array<{ fn: () => void; ms: number; unref: jest.Mock }>;
}

function harness(): Harness {
  return { proc: new EventEmitter(), exits: [], lines: [], timers: [] };
}

function deps(h: Harness) {
  return {
    proc: h.proc as unknown as SignalProcess,
    exit: (code: number) => {
      h.exits.push(code);
    },
    write: (line: string) => {
      h.lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    now: () => new Date("2026-10-26T10:00:00.000Z"),
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, unref: jest.fn() };
      h.timers.push(t);
      return t;
    },
  };
}

beforeEach(() => resetShutdownStateForTest());

describe("installGracefulShutdown — gỡ và giữ handler tín hiệu gắn sau (của Medusa)", () => {
  it("SIGTERM → draining (readiness 503) ngay; handler Medusa CHỈ chạy sau drainDelay", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 5_000, timeoutMs: 25_000 }, deps(h));
    const medusa = jest.fn();
    h.proc.on("SIGTERM", medusa);
    await flush();
    // Handler của Medusa đã bị gỡ khỏi tiến trình, chỉ còn handler của ta.
    expect(h.proc.listenerCount("SIGTERM")).toBe(1);

    h.proc.emit("SIGTERM");
    expect(isDraining()).toBe(true);
    expect(shutdownState().signal).toBe("SIGTERM");
    expect(medusa).not.toHaveBeenCalled();
    // Hai bộ hẹn giờ: trần cứng (unref) + chờ drain.
    const [hard, drain] = h.timers;
    expect(hard?.ms).toBe(25_000);
    expect(hard?.unref).toHaveBeenCalled();
    expect(drain?.ms).toBe(5_000);

    drain!.fn();
    await flush();
    expect(medusa).toHaveBeenCalledWith("SIGTERM");
    expect(h.exits).toEqual([]); // Medusa tự thoát 0 sau khi đóng pool
    expect(h.lines.map((l) => l.event)).toEqual(["shutdown", "shutdown"]);
    expect(h.lines[0]).toMatchObject({
      level: "info",
      timestamp: "2026-10-26T10:00:00.000Z",
      signal: "SIGTERM",
      drain_delay_ms: 5_000,
      timeout_ms: 25_000,
    });
  });

  it("quá trần → log lỗi + thoát mã 1", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 3_000 }, deps(h));
    h.proc.on("SIGTERM", () => {
      // Medusa treo (request không bao giờ xong) — không thoát.
    });
    await flush();
    h.proc.emit("SIGTERM");
    await flush();
    h.timers[0]!.fn();
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({ level: "error", timeout_ms: 3_000 });
  });

  it("drainDelay 0 → chuyển giao ngay trong lượt kế, không chờ bộ hẹn giờ", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 3_000 }, deps(h));
    const medusa = jest.fn();
    h.proc.on("SIGINT", medusa);
    await flush();
    h.proc.emit("SIGINT");
    await flush();
    expect(medusa).toHaveBeenCalledWith("SIGINT");
    expect(h.timers).toHaveLength(1); // chỉ trần cứng
  });

  it("đồng thời: SIGTERM lặp lại / SIGINT chen vào trong lúc tắt → chỉ một lượt tắt, handler Medusa gọi đúng một lần", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 1_000, timeoutMs: 3_000 }, deps(h));
    const term = jest.fn();
    const int = jest.fn();
    h.proc.on("SIGTERM", term);
    h.proc.on("SIGINT", int);
    await flush();
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGTERM");
    h.proc.emit("SIGINT");
    expect(h.timers).toHaveLength(2);
    h.timers[1]!.fn();
    await flush();
    expect(term).toHaveBeenCalledTimes(1);
    expect(int).not.toHaveBeenCalled();
    expect(h.lines.filter((l) => l.level === "warn")).toHaveLength(2);
  });

  it("không có handler Medusa (không chạy dưới medusa start) → thoát 0 sau drain", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 3_000 }, deps(h));
    h.proc.emit("SIGTERM");
    await flush();
    expect(h.exits).toEqual([0]);
  });

  it("handler Medusa ném lỗi → thoát mã 1, log có exception.type/message", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 3_000 }, deps(h));
    h.proc.on("SIGTERM", () => {
      throw new TypeError("server undefined");
    });
    await flush();
    h.proc.emit("SIGTERM");
    await flush();
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({
      "exception.type": "TypeError",
      "exception.message": "server undefined",
    });
  });

  it("idempotent: cài lần hai trên cùng tiến trình → null, không gắn thêm handler", () => {
    const h = harness();
    expect(installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 1_000 }, deps(h))).not.toBeNull();
    expect(installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 1_000 }, deps(h))).toBeNull();
    expect(h.proc.listenerCount("SIGTERM")).toBe(1);
  });

  it("sự kiện khác (không phải SIGTERM/SIGINT) không bị gỡ", async () => {
    const h = harness();
    installGracefulShutdown({ drainDelayMs: 0, timeoutMs: 1_000 }, deps(h));
    h.proc.on("SIGHUP", () => undefined);
    h.proc.on("exit", () => undefined);
    await flush();
    expect(h.proc.listenerCount("SIGHUP")).toBe(1);
    expect(h.proc.listenerCount("exit")).toBe(1);
  });
});

describe("createShutdownController — trạng thái dùng chung", () => {
  it("chưa có tín hiệu → không draining", () => {
    createShutdownController({ drainDelayMs: 0, timeoutMs: 1_000 }, deps(harness()));
    expect(isDraining()).toBe(false);
  });
});

describe("cấu hình SHUTDOWN_* (env.ts)", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

  it("mặc định dev: drain 0, trần 25 s", () => {
    const r = parseEnv(base);
    expect(r.ok && r.env.shutdown).toEqual({ drainDelayMs: 0, timeoutMs: 25_000 });
  });

  it("đặt rõ drain/trần", () => {
    const r = parseEnv({ ...base, SHUTDOWN_DRAIN_DELAY_MS: "1500", SHUTDOWN_TIMEOUT_MS: "8000" });
    expect(r.ok && r.env.shutdown).toEqual({ drainDelayMs: 1_500, timeoutMs: 8_000 });
  });

  it.each([
    [{ SHUTDOWN_DRAIN_DELAY_MS: "-1" }, "SHUTDOWN_DRAIN_DELAY_MS"],
    [{ SHUTDOWN_DRAIN_DELAY_MS: "60001" }, "SHUTDOWN_DRAIN_DELAY_MS"],
    [{ SHUTDOWN_DRAIN_DELAY_MS: "abc" }, "SHUTDOWN_DRAIN_DELAY_MS"],
    [{ SHUTDOWN_TIMEOUT_MS: "999" }, "SHUTDOWN_TIMEOUT_MS"],
    [{ SHUTDOWN_TIMEOUT_MS: "0" }, "SHUTDOWN_TIMEOUT_MS"],
    [{ SHUTDOWN_DRAIN_DELAY_MS: "5000", SHUTDOWN_TIMEOUT_MS: "5000" }, "SHUTDOWN_DRAIN_DELAY_MS"],
  ])("sai %j → lỗi nêu tên %s", (extra, variable) => {
    const r = parseEnv({ ...base, ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.variable)).toContain(variable);
  });

  it("drain rỗng → mặc định; trần nhỏ hơn mặc định drain production → drain bị kẹp dưới trần", () => {
    const r = parseEnv({ ...base, SHUTDOWN_DRAIN_DELAY_MS: " ", SHUTDOWN_TIMEOUT_MS: "1000" });
    expect(r.ok && r.env.shutdown).toEqual({ drainDelayMs: 0, timeoutMs: 1_000 });
  });
});
