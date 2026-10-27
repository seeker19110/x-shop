import { writeSync } from "node:fs";

/**
 * Lỗi ngoài mọi request (BASE-ERR-002, T-088): `unhandledRejection` / `uncaughtException` → ghi MỘT dòng JSON có cấu trúc ra
 * stderr (đồng bộ — không mất khi tiến trình thoát ngay sau) rồi thoát mã 1. Không nuốt lỗi: sau ngoại lệ chưa bắt, trạng
 * thái tiến trình không còn tin được (Node docs) → để bộ điều phối khởi động lại instance sạch; mã ≠ 0 để nó biết là sự cố.
 * Rút request đang dở/đóng pool khi tắt là phần của tắt êm (T-094).
 *
 * Khoá theo tên thuộc tính ngoại lệ của OpenTelemetry (`exception.type/message/stacktrace`). Không phụ thuộc module nào
 * khác (chạy được trước khi container Medusa dựng xong) — cài ở `instrumentation.ts` (Medusa gọi `register()` khi
 * `medusa start`, cả server và worker).
 */

export type FatalEvent = "uncaughtException" | "unhandledRejection";

export interface ProcessLike {
  on(event: FatalEvent, listener: (reason: unknown) => void): unknown;
}

export interface ProcessHandlerOptions {
  proc?: ProcessLike;
  /** Ghi một dòng (mặc định: ghi đồng bộ fd 2). */
  write?: (line: string) => void;
  exit?: (code: number) => void;
  now?: () => Date;
  service?: string;
}

const INSTALLED = Symbol.for("x-shop.process-error-handlers");

function exceptionFields(reason: unknown): Record<string, string> {
  if (reason instanceof Error) {
    return {
      "exception.type": reason.name || "Error",
      "exception.message": reason.message,
      ...(typeof reason.stack === "string" && reason.stack !== ""
        ? { "exception.stacktrace": reason.stack }
        : {}),
    };
  }
  let message: string;
  try {
    message = typeof reason === "string" ? reason : (JSON.stringify(reason) ?? String(reason));
  } catch {
    message = String(reason);
  }
  return { "exception.type": reason === null ? "null" : typeof reason, "exception.message": message };
}

/** Một dòng log JSON (không CR/LF thô — JSON.stringify thoát mọi ký tự điều khiển). */
export function fatalLogLine(event: FatalEvent, reason: unknown, now: Date, service: string): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: "fatal",
    service,
    event,
    message:
      event === "uncaughtException"
        ? "Ngoại lệ chưa bắt — thoát tiến trình"
        : "Promise bị từ chối không ai xử lý — thoát tiến trình",
    ...exceptionFields(reason),
  });
}

/**
 * Cài handler (idempotent theo tiến trình). Trả `false` nếu đã cài trước đó. Lỗi thứ hai trong lúc đang thoát chỉ được
 * ghi log, không gọi exit lần nữa.
 */
export function installProcessErrorHandlers(opts: ProcessHandlerOptions = {}): boolean {
  const proc = opts.proc ?? process;
  const holder = proc as unknown as Record<symbol, boolean>;
  if (holder[INSTALLED] === true) return false;
  holder[INSTALLED] = true;
  const write =
    opts.write ??
    ((line: string) => {
      try {
        writeSync(2, line + "\n");
      } catch {
        // stderr đóng — vẫn phải thoát.
      }
    });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? (() => new Date());
  const service = opts.service ?? "x-shop-backend";
  let exiting = false;
  const onFatal = (event: FatalEvent) => (reason: unknown) => {
    try {
      write(fatalLogLine(event, reason, now(), service));
    } finally {
      if (!exiting) {
        exiting = true;
        exit(1);
      }
    }
  };
  proc.on("uncaughtException", onFatal("uncaughtException"));
  proc.on("unhandledRejection", onFatal("unhandledRejection"));
  return true;
}
