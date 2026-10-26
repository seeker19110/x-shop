import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { REQUEST_ID_PATTERN, traceIdOf } from "../errors/trace";
import { isAppLogger, newSpanId, runWithLogContext, type AppLogger, type LogContext } from "./logger";

/**
 * Ngữ cảnh log theo request + log truy cập (BASE-ERR-006, T-090).
 *  - `trace_id` = mã tham chiếu request (cùng mã trả trong problem+json, `lib/errors/trace.ts`), `span_id` mới cho request;
 *    mọi log trong request (middleware, route, workflow, handler lỗi) tự mang hai trường này qua AsyncLocalStorage;
 *  - khi phản hồi xong/kết nối đóng: một bản ghi `http.server.request` — method, ĐƯỜNG DẪN KHÔNG query (query có thể chứa
 *    token/PII), status, thời gian; không IP, không header, không thân. Bỏ qua probe sức khoẻ (nhiễu).
 *
 * Hai điểm gắn:
 *  1. `installRequestLogHook()` (instrumentation.ts, `medusa start`): `traceRequestHandler` của
 *     `@medusajs/medusa/commands/start` — điểm bọc MỌI request trước toàn bộ middleware (cùng điểm Medusa dùng cho
 *     OpenTelemetry, `@medusajs/medusa/dist/instrumentation`) → ghi được cả request bị middleware lõi chặn sớm (thiếu
 *     publishable key, CORS…). Handler có sẵn (nếu bật OTel của Medusa) được bọc tiếp, không bị thay.
 *  2. `requestLogContext` (middleware toàn cục `matcher: "/"`): dự phòng khi không có (1) — test tích hợp dựng app không
 *     qua `medusa start`; request đã qua (1) thì bỏ qua (không ghi trùng).
 */

const SKIP = new Set(["/health", "/x/health", "/x/readyz"]);
const HANDLED = Symbol.for("x-shop.log.request-handled");

export function pathOf(req: { originalUrl?: unknown; url?: unknown }): string {
  const raw =
    typeof req.originalUrl === "string" ? req.originalUrl : typeof req.url === "string" ? req.url : "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

interface ReqLike {
  method?: string;
  originalUrl?: unknown;
  url?: unknown;
  scope?: { resolve(key: string): unknown };
}
interface ResLike {
  statusCode: number;
  writableFinished?: boolean;
  once(event: "finish" | "close", fn: () => void): unknown;
}

function containerLogger(req: ReqLike): AppLogger | null {
  try {
    const l = req.scope?.resolve(ContainerRegistrationKeys.LOGGER);
    return isAppLogger(l) ? l : null;
  } catch {
    return null;
  }
}

/** Gắn log truy cập khi phản hồi xong (một lần). Logger lấy lúc ghi: container (nếu đã có scope) → `fallback`. */
function trackAccess(req: ReqLike, res: ResLike, ctx: LogContext, fallback: AppLogger | null): void {
  const path = pathOf(req);
  if (SKIP.has(path)) return;
  const start = process.hrtime.bigint();
  let done = false;
  const finish = (aborted: boolean) => {
    if (done) return;
    done = true;
    const logger = containerLogger(req) ?? fallback;
    if (logger === null) return;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    runWithLogContext(ctx, () =>
      logger.emit(res.statusCode >= 500 ? "error" : "info", "http.server.request", {
        "http.request.method": req.method,
        "url.path": path,
        "http.response.status_code": res.statusCode,
        duration_ms: Math.round(durationMs * 1000) / 1000,
        ...(aborted && { "http.aborted": true }),
      }),
    );
  };
  res.once("finish", () => finish(false));
  res.once("close", () => finish(res.writableFinished !== true));
}

export function requestLogContext(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction): void {
  if ((req as unknown as Record<symbol, unknown>)[HANDLED] === true) {
    next();
    return;
  }
  const ctx = { trace_id: traceIdOf(req), span_id: newSpanId() };
  trackAccess(req as unknown as ReqLike, res as unknown as ResLike, ctx, null);
  runWithLogContext(ctx, () => next());
}

type RequestHandler = () => Promise<void>;
type TraceRequestHandler = (
  requestHandler: RequestHandler,
  req: unknown,
  res: unknown,
  handlerPath?: string,
) => Promise<void>;

export interface TraceHookTarget {
  traceRequestHandler?: TraceRequestHandler;
}

/**
 * Bọc mọi request của `medusa start`. `x-request-id` hợp lệ được giữ; thiếu/xấu → sinh UUID và GHI LẠI header để middleware
 * đầu tiên của Medusa (`req.requestId = header ?? uuid`) và `traceIdOf` dùng cùng mã. Trả `false` nếu đã cài.
 */
export function installRequestLogHook(fallback: AppLogger, target?: TraceHookTarget): boolean {
  const t = target ?? (createRequire(__filename)("@medusajs/medusa/commands/start") as TraceHookTarget);
  const prev = t.traceRequestHandler;
  if ((prev as unknown as Record<symbol, unknown> | undefined)?.[HANDLED] === true) return false;
  const hook: TraceRequestHandler = async (requestHandler, req, res, handlerPath) => {
    const r = req as ReqLike & { headers?: Record<string, unknown> } & Record<symbol, unknown>;
    const headers = r.headers ?? {};
    const given = headers["x-request-id"];
    const trace_id = typeof given === "string" && REQUEST_ID_PATTERN.test(given) ? given : randomUUID();
    headers["x-request-id"] = trace_id;
    r[HANDLED] = true;
    const ctx = { trace_id, span_id: newSpanId() };
    trackAccess(r, res as ResLike, ctx, fallback);
    await runWithLogContext(ctx, () =>
      prev !== undefined ? prev(requestHandler, req, res, handlerPath) : requestHandler(),
    );
  };
  (hook as unknown as Record<symbol, unknown>)[HANDLED] = true;
  t.traceRequestHandler = hook;
  return true;
}
