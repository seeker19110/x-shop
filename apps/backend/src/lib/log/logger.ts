import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { format } from "node:util";
import { redactLog, redactText } from "./redact";

/**
 * Logger có cấu trúc của backend (BASE-ERR-005/006/008/009, T-090) — thay logger mặc định của Medusa qua
 * `defineConfig({ logger })` (container `LOGGER`: module, workflow, job, route, middleware của dự án).
 *
 * Mỗi bản ghi = MỘT dòng JSON ra stdout (không tự ghi/xoay file, không gửi đi đâu — việc của Collector, OPS-OBS-001):
 *   `timestamp` RFC 3339 UTC độ phân giải ms (`…Z`) · `level` + `severity_number` theo OTel Logs Data Model
 *   (trace 1, debug 5, info 9, warn 13, error 17, fatal 21) · `message` · `service` · `version` · `env`
 *   · trong request: `trace_id`, `span_id` (AsyncLocalStorage, middleware `requestLogContext`)
 *   · ngoại lệ: `exception.type`, `exception.message`, `exception.stacktrace` (OTel semconv) — stacktrace gồm cả chuỗi
 *     `cause` (`Caused by: …`) và `errors` của AggregateError, không cắt.
 * Mọi trường (kể cả message, stack) đi qua `redactLog` (bí mật + PII VN). Chống log injection: JSON.stringify thoát CR/LF/
 * ký tự điều khiển C0; thêm thoát C1 (U+0080–U+009F, gồm NEL), U+2028/U+2029 và ký tự điều khiển hướng chữ (bidi) — một
 * bản ghi không bao giờ thành nhiều dòng hay hiển thị sai thứ tự.
 *
 * Mức `http` của Medusa: `shouldLog("http")` luôn `false` → log truy cập morgan của Medusa (in thẳng stdout, URL đầy đủ kèm
 * query, ngoài bộ che) tắt; thay bằng log truy cập của `requestLogContext` (đường dẫn không query, đã che).
 */

export type Severity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export const SEVERITY_NUMBER: Record<Severity, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

/** Mức của Medusa/winston (LOG_LEVEL) → mức OTel. */
export const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const THRESHOLD: Record<LogLevel, number> = {
  error: SEVERITY_NUMBER.error,
  warn: SEVERITY_NUMBER.warn,
  info: SEVERITY_NUMBER.info,
  // Log truy cập của dự án ở mức info → `http` (mặc định của Medusa) tương đương info.
  http: SEVERITY_NUMBER.info,
  verbose: SEVERITY_NUMBER.debug,
  debug: SEVERITY_NUMBER.debug,
  silly: SEVERITY_NUMBER.trace,
};
const MEDUSA_LEVEL: Record<string, Severity> = {
  error: "error",
  warn: "warn",
  info: "info",
  http: "debug",
  verbose: "debug",
  debug: "debug",
  silly: "trace",
};

export interface LogContext {
  trace_id?: string;
  span_id?: string;
}

const STORAGE = Symbol.for("x-shop.log.context");
/** Một kho ngữ cảnh cho cả tiến trình (logger và middleware có thể nạp qua hai đường module). */
function storage(): AsyncLocalStorage<LogContext> {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<LogContext> | undefined>;
  return (g[STORAGE] ??= new AsyncLocalStorage<LogContext>());
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage().run(ctx, fn);
}

export function currentLogContext(): LogContext | undefined {
  return storage().getStore();
}

/** span_id W3C: 8 byte ngẫu nhiên, hex thường, không toàn 0 (W3C: toàn 0 là không hợp lệ). */
export function newSpanId(random: (n: number) => Buffer = randomBytes): string {
  const b = random(8);
  if (b.every((x) => x === 0)) b[7] = 1;
  return b.toString("hex");
}

export type ExceptionFields = Record<"exception.type" | "exception.message", string> & {
  "exception.stacktrace"?: string;
};

const MAX_CAUSE_DEPTH = 32;

function describeNonError(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    // Che từng trường trước khi stringify (`\"` làm mẫu SQL/PII không khớp, T-151).
    return JSON.stringify(redactLog(v)) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Trường ngoại lệ theo OTel; stacktrace nối cả chuỗi `cause`/`errors` (chống vòng, trần độ sâu). */
export function exceptionFields(err: unknown): ExceptionFields {
  if (!(err instanceof Error)) {
    return {
      "exception.type": err === null ? "null" : typeof err,
      "exception.message": describeNonError(err),
    };
  }
  const seen = new Set<unknown>();
  const lines: string[] = [];
  const walk = (e: unknown, prefix: string, depth: number) => {
    if (depth > MAX_CAUSE_DEPTH) {
      lines.push(`${prefix}[chuỗi nguyên nhân quá sâu]`);
      return;
    }
    if (seen.has(e)) {
      lines.push(`${prefix}[Circular]`);
      return;
    }
    seen.add(e);
    if (e instanceof Error) {
      lines.push(prefix + (typeof e.stack === "string" ? e.stack : `${e.name}: ${e.message}`));
      if (e instanceof AggregateError) {
        e.errors.forEach((sub, i) => walk(sub, `[errors ${i}] `, depth + 1));
      }
      if (e.cause !== undefined) walk(e.cause, "Caused by: ", depth + 1);
    } else {
      lines.push(prefix + describeNonError(e));
    }
  };
  walk(err, "", 0);
  return {
    "exception.type": err.name || err.constructor.name || "Error",
    "exception.message": err.message,
    "exception.stacktrace": lines.join("\n"),
  };
}

/** Thoát ký tự có thể bị bộ đọc log hiểu là xuống dòng/đổi hướng mà JSON.stringify để nguyên. */
// RegExp từ chuỗi có escape: ký tự U+2028/U+2029 thô trong regex literal là lỗi cú pháp.
const UNSAFE = new RegExp("[\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
export function escapeLine(json: string): string {
  return json.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export interface LoggerOptions {
  service: string;
  version: string;
  env: string;
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
  exit?: (code: number) => void;
}

const RESERVED = new Set([
  "timestamp",
  "level",
  "severity_number",
  "message",
  "service",
  "version",
  "env",
  // Ngữ cảnh trace chỉ đến từ runWithLogContext, `fields` không được đè/giả.
  "trace_id",
  "span_id",
  "parent_span_id",
]);

/** Logger tương thích interface `Logger` của Medusa 2.22.1 + `emit()` có trường cấu trúc. */
export class AppLogger {
  private readonly opts: Required<Omit<LoggerOptions, "level">>;
  private readonly defaultLevel: LogLevel;
  private level: LogLevel;
  private readonly activities = new Map<string, number>();

  constructor(options: LoggerOptions) {
    this.opts = {
      service: options.service,
      version: options.version,
      env: options.env,
      write: options.write ?? ((line) => process.stdout.write(`${line}\n`)),
      now: options.now ?? (() => new Date()),
      exit: options.exit ?? ((code) => process.exit(code)),
    };
    this.defaultLevel = options.level ?? "info";
    this.level = this.defaultLevel;
    // Medusa/thư viện có thể gọi phương thức tách rời (`const { info } = logger`, stream của morgan) → gắn `this`.
    for (const name of Object.getOwnPropertyNames(AppLogger.prototype)) {
      const fn = (this as unknown as Record<string, unknown>)[name];
      if (name !== "constructor" && typeof fn === "function")
        (this as unknown as Record<string, unknown>)[name] = (fn as (...a: unknown[]) => unknown).bind(this);
    }
  }

  enabled(severity: Severity): boolean {
    return SEVERITY_NUMBER[severity] >= THRESHOLD[this.level];
  }

  /** Ghi một bản ghi. `fields` có thể chứa bất kỳ dữ liệu nào — luôn qua bộ che trước khi tuần tự hoá. */
  emit(severity: Severity, message: string, fields: Record<string, unknown> = {}, error?: unknown): void {
    if (!this.enabled(severity)) return;
    try {
      const ctx = currentLogContext();
      const extra: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) if (!RESERVED.has(k)) extra[k] = v;
      const record = {
        timestamp: this.opts.now().toISOString(),
        level: severity,
        severity_number: SEVERITY_NUMBER[severity],
        message: redactText(message),
        service: this.opts.service,
        version: this.opts.version,
        env: this.opts.env,
        ...(ctx?.trace_id !== undefined && { trace_id: ctx.trace_id }),
        // Schema: có trace_id thì bắt buộc span_id (BASE-ERR-006) — ngữ cảnh thiếu span thì sinh span mới.
        ...(ctx?.trace_id !== undefined && { span_id: ctx.span_id ?? newSpanId() }),
        ...(ctx?.trace_id === undefined && ctx?.span_id !== undefined && { span_id: ctx.span_id }),
        ...(redactLog(extra) as Record<string, unknown>),
        ...(error !== undefined && (redactLog(exceptionFields(error)) as Record<string, unknown>)),
      };
      this.opts.write(escapeLine(JSON.stringify(record)));
    } catch {
      // Logger không bao giờ làm hỏng luồng nghiệp vụ.
    }
  }

  // ——— interface Logger của Medusa ———

  shouldLog(level: string): boolean {
    if (level === "http") return false;
    const sev = MEDUSA_LEVEL[level];
    return sev !== undefined && this.enabled(sev);
  }

  setLogLevel(level: string): void {
    if ((LOG_LEVELS as readonly string[]).includes(level)) this.level = level as LogLevel;
  }

  unsetLogLevel(): void {
    this.level = this.defaultLevel;
  }

  panic(data: unknown): void {
    const d = (typeof data === "object" && data !== null ? data : {}) as { id?: unknown; context?: unknown };
    this.emit("fatal", "Medusa panic", { panic_id: d.id, panic_context: d.context });
    this.opts.exit(1);
  }

  activity(message: string, config?: unknown): string {
    const id = newSpanId();
    this.activities.set(id, Date.now());
    this.emit("info", message, { activity_id: id, ...(config !== undefined && { activity_config: config }) });
    return id;
  }

  progress(activityId: string, message: string): void {
    this.emit("info", message, { activity_id: activityId });
  }

  private finish(activityId: string): { activity: string; duration?: number } {
    const start = this.activities.get(activityId);
    this.activities.delete(activityId);
    return start === undefined
      ? { activity: activityId }
      : { activity: activityId, duration: Date.now() - start };
  }

  success(activityId: string, message: string): Record<string, unknown> {
    const r = this.finish(activityId);
    this.emit("info", message, { activity_id: activityId, duration_ms: r.duration });
    return r;
  }

  failure(activityId: string, message: string): unknown {
    const r = this.finish(activityId);
    this.emit("error", message, { activity_id: activityId, duration_ms: r.duration });
    return r;
  }

  error(messageOrError: string | Error, error?: Error): void {
    if (typeof messageOrError === "string") this.emit("error", messageOrError, {}, error);
    else
      this.emit("error", messageOrError instanceof Error ? messageOrError.message : "", {}, messageOrError);
  }

  warn(message: string): void {
    this.emit("warn", String(message));
  }

  info(message: string): void {
    this.emit("info", String(message));
  }

  http(message: string): void {
    this.emit("debug", String(message), { "log.type": "http" });
  }

  verbose(message: string): void {
    this.emit("debug", String(message));
  }

  debug(message: string): void {
    this.emit("debug", String(message));
  }

  silly(message: string): void {
    this.emit("trace", String(message));
  }

  log(...args: unknown[]): void {
    const err = args.find((a): a is Error => a instanceof Error);
    this.emit("info", format(...args.filter((a) => a !== err)), {}, err);
  }
}

export function createLogger(options: LoggerOptions): AppLogger {
  return new AppLogger(options);
}

export function isAppLogger(v: unknown): v is AppLogger {
  return (
    v instanceof AppLogger ||
    (typeof v === "object" && v !== null && typeof (v as AppLogger).emit === "function")
  );
}
