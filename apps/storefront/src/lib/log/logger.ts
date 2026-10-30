import { readLogEnv } from "../env/log";
import { redactLog, redactText } from "./redact";

/**
 * Logger JSON có cấu trúc của storefront SERVER (BASE-ERR-005/006, T-190) — cùng hợp đồng với backend
 * (`docs/ops/log-schema.json`): mỗi bản ghi MỘT dòng JSON ra stdout, không ghi file, không gửi đi đâu (việc của Collector):
 *   `timestamp` RFC 3339 UTC ms (`…Z`) · `level` + `severity_number` (OTel: debug 5, info 9, warn 13, error 17, fatal 21) ·
 *   `message` · `service` · `version` · `env` · `trace_id` · ngoại lệ `exception.type/message/stacktrace` (OTel semconv).
 * `trace_id`: `x-request-id` hợp lệ → trace-id của `traceparent` (W3C) → sinh mới (32 hex). Header là dữ liệu không tin
 * cậy: chỉ nhận khi khớp mẫu an toàn cho log/JSON.
 * Mọi trường đi qua `redactLog`/`redactText` (bí mật + PII). Logger không bao giờ ném.
 *
 * CHỈ SERVER: không import từ file "use client" (test `logger.test.ts` quét); chạy ở trình duyệt → ném ngay khi nạp, để lỗi
 * lộ lúc build/test thay vì lặng lẽ kéo mã log vào bundle client.
 */
if (typeof window !== "undefined" && typeof document !== "undefined") {
  throw new Error("lib/log chỉ dùng phía server (không import vào client component)");
}

export type Severity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export const SEVERITY_NUMBER: Record<Severity, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

export const SERVICE_NAME = "x-shop-storefront";
/** Cùng mẫu với backend (`REQUEST_ID_PATTERN`). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** W3C Trace Context: chỉ hex thường; version `ff` cấm; trace-id và parent-id không được toàn 0. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE = /^0{32}$/;
const ALL_ZERO_PARENT = /^0{16}$/;

/** Trường dành riêng: không cho `fields` ghi đè. */
const RESERVED = new Set(["timestamp", "level", "severity_number", "message", "service", "version", "env"]);

export type HeaderBag =
  { get(name: string): string | null } | Record<string, string | string[] | undefined> | undefined | null;

function headerValue(headers: HeaderBag, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : bag[key];
  return Array.isArray(v) ? v[0] : v;
}

/** 16 byte ngẫu nhiên → 32 hex (trace-id W3C), không phụ thuộc module Node. */
export function newTraceId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  if (b.every((x) => x === 0)) b[15] = 1;
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** `trace_id` của một request: `x-request-id` hợp lệ → `traceparent` hợp lệ → sinh mới. */
export function traceIdFromHeaders(headers: HeaderBag): string {
  const rid = headerValue(headers, "x-request-id")?.trim();
  if (rid !== undefined && REQUEST_ID_PATTERN.test(rid)) return rid;
  const tp = headerValue(headers, "traceparent")?.trim();
  const m = tp === undefined ? null : TRACEPARENT.exec(tp);
  if (
    m?.[1] !== undefined &&
    m[1] !== "ff" &&
    m[2] !== undefined &&
    m[3] !== undefined &&
    !ALL_ZERO_TRACE.test(m[2]) &&
    !ALL_ZERO_PARENT.test(m[3])
  )
    return m[2];
  return newTraceId();
}

export interface ExceptionFields {
  "exception.type": string;
  "exception.message": string;
  "exception.stacktrace"?: string;
}

const MAX_CAUSE_DEPTH = 8;

/** Trường ngoại lệ theo OTel; stacktrace nối cả chuỗi `cause` (chống vòng, trần độ sâu). */
export function exceptionFields(err: unknown): ExceptionFields {
  if (!(err instanceof Error)) {
    let message: string;
    try {
      message = typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
    } catch {
      message = String(err);
    }
    return { "exception.type": err === null ? "null" : typeof err, "exception.message": message };
  }
  const seen = new Set<unknown>();
  const lines: string[] = [];
  let cur: unknown = err;
  let prefix = "";
  for (let i = 0; i <= MAX_CAUSE_DEPTH; i++) {
    if (seen.has(cur)) {
      lines.push(`${prefix}[Circular]`);
      break;
    }
    seen.add(cur);
    if (cur instanceof Error) {
      lines.push(prefix + (typeof cur.stack === "string" ? cur.stack : `${cur.name}: ${cur.message}`));
      if (cur.cause === undefined) break;
      cur = cur.cause;
    } else {
      lines.push(prefix + String(cur));
      break;
    }
    prefix = "Caused by: ";
  }
  return {
    "exception.type": err.name || "Error",
    "exception.message": err.message,
    "exception.stacktrace": lines.join("\n"),
  };
}

/** Thoát ký tự mà JSON.stringify để nguyên nhưng bộ đọc log có thể hiểu là xuống dòng/đổi hướng. */
const UNSAFE = new RegExp("[\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
export function escapeLine(json: string): string {
  return json.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export interface LoggerOptions {
  service?: string;
  version?: string;
  env?: string;
  level?: Severity;
  write?: (line: string) => void;
  now?: () => Date;
}

const SAFE_META = /^[0-9A-Za-z.+_-]{1,64}$/;
const metaOr = (v: string | undefined, fallback: string) =>
  v !== undefined && SAFE_META.test(v) ? v : fallback;

function defaultWrite(line: string): void {
  if (typeof process !== "undefined" && typeof process.stdout?.write === "function") {
    process.stdout.write(`${line}\n`);
  } else {
    // eslint-disable-next-line no-console -- runtime không có process.stdout: đường ra duy nhất của logger
    console.log(line);
  }
}

export class Logger {
  private readonly service: string;
  private readonly version: string;
  private readonly env: string;
  private readonly level: Severity;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;
  private readonly bound: Record<string, unknown>;

  constructor(options: LoggerOptions = {}, bound: Record<string, unknown> = {}) {
    this.service = options.service ?? SERVICE_NAME;
    const fromEnv = readLogEnv();
    this.version = metaOr(options.version ?? fromEnv.version, "unknown");
    this.env = metaOr(options.env ?? fromEnv.env, "unknown");
    this.level = options.level ?? fromEnv.level ?? "info";
    this.write = options.write ?? defaultWrite;
    this.now = options.now ?? (() => new Date());
    this.bound = bound;
  }

  enabled(severity: Severity): boolean {
    return SEVERITY_NUMBER[severity] >= SEVERITY_NUMBER[this.level];
  }

  /** Logger con mang sẵn `trace_id` (và trường khác) của một request. */
  child(fields: Record<string, unknown>): Logger {
    return new Logger(
      {
        service: this.service,
        version: this.version,
        env: this.env,
        level: this.level,
        write: this.write,
        now: this.now,
      },
      { ...this.bound, ...fields },
    );
  }

  /** Logger con theo header của request (`x-request-id`/`traceparent`). */
  forRequest(headers: HeaderBag): Logger {
    return this.child({ trace_id: traceIdFromHeaders(headers) });
  }

  emit(severity: Severity, message: string, fields: Record<string, unknown> = {}, error?: unknown): void {
    if (!this.enabled(severity)) return;
    try {
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({ ...this.bound, ...fields })) if (!RESERVED.has(k)) merged[k] = v;
      const rawTrace = merged.trace_id;
      delete merged.trace_id;
      const trace_id =
        typeof rawTrace === "string" && REQUEST_ID_PATTERN.test(rawTrace) ? rawTrace : newTraceId();
      const record = {
        timestamp: this.now().toISOString(),
        level: severity,
        severity_number: SEVERITY_NUMBER[severity],
        message: redactText(String(message)),
        service: this.service,
        version: this.version,
        env: this.env,
        trace_id,
        ...(redactLog(merged) as Record<string, unknown>),
        ...(error !== undefined && redactException(exceptionFields(error))),
      };
      this.write(escapeLine(JSON.stringify(record)));
    } catch {
      // Logger không bao giờ làm hỏng luồng nghiệp vụ.
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("warn", message, fields);
  }
  error(message: string, error?: unknown, fields?: Record<string, unknown>): void {
    this.emit("error", message, fields, error);
  }
  fatal(message: string, error?: unknown, fields?: Record<string, unknown>): void {
    this.emit("fatal", message, fields, error);
  }
}

function redactException(f: ExceptionFields): ExceptionFields {
  return {
    "exception.type": redactText(f["exception.type"]),
    "exception.message": redactText(f["exception.message"]),
    ...(f["exception.stacktrace"] !== undefined && {
      "exception.stacktrace": redactText(f["exception.stacktrace"], true),
    }),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

let shared: Logger | undefined;
/** Logger dùng chung của tiến trình (cấu hình từ môi trường lúc dùng lần đầu). */
export function getLogger(): Logger {
  return (shared ??= createLogger());
}

/** Chỉ cho test. */
export function resetLoggerForTests(): void {
  shared = undefined;
}
