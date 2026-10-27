import { createRequire } from "node:module";
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { traceIdOf } from "../errors/trace";
import { isAppLogger, newSpanId, runWithLogContext, type AppLogger, type LogContext } from "./logger";

/**
 * Ngữ cảnh log theo request + log truy cập (BASE-ERR-006, T-090) — middleware toàn cục (`matcher: "/"`, Medusa xếp nhóm
 * global lên đầu các middleware của dự án):
 *  - `trace_id` = mã tham chiếu request (cùng mã trả trong problem+json, `lib/errors/trace.ts`), `span_id` mới cho request;
 *    mọi log sau đó trong request (route, workflow, handler lỗi) tự mang hai trường này qua AsyncLocalStorage;
 *  - khi phản hồi xong/kết nối đóng: một bản ghi `http.server.request` — method, ĐƯỜNG DẪN KHÔNG query (query có thể chứa
 *    token/PII), cắt tối đa `MAX_PATH` ký tự, status, thời gian; không IP, không header, không thân. Bỏ qua probe sức khoẻ.
 *
 * Log truy cập gắn ở MỨC SERVER HTTP: `installAccessLogServerHook()` (instrumentation.ts — Medusa gọi `register()` TRƯỚC
 * `http.createServer` trong `medusa start`) bọc `http.createServer` và `emit` của server để theo dõi req/res thô TRƯỚC mọi
 * listener → ghi cả request bị middleware lõi Medusa từ chối sớm (401 Admin, thiếu publishable key, URL mã hoá hỏng). Cùng
 * chỗ đó chặn request-target không phải origin-form (T-145, 400 trước Express). Mọi bước bọc try/catch, không ném ra ngoài. Middleware `requestLogContext` khi đó chỉ đặt ngữ cảnh (không ghi trùng); không có
 * hook (test tích hợp dựng app không qua `medusa start`) thì middleware tự ghi log truy cập.
 *
 * KHÔNG dùng `traceRequestHandler` của `@medusajs/medusa/commands/start`: gán nó bật nhánh `findExpressRoutePath` của
 * Medusa 2.22.1 (`layer.match`/`url.parse` không try/catch trong executor Promise) → `/auth/user/%FF` hoặc URL dạng tuyệt
 * đối làm sập tiến trình (unhandledRejection).
 */

const SKIP = new Set(["/health", "/x/health", "/x/readyz"]);
const TRACKED = Symbol.for("x-shop.log.access-tracked");
const SPAN = Symbol.for("x-shop.log.span-id");
const HOOKED = Symbol.for("x-shop.log.server-hook");
export const MAX_PATH = 256;

export function pathOf(req: { originalUrl?: unknown; url?: unknown }): string {
  const raw =
    typeof req.originalUrl === "string" ? req.originalUrl : typeof req.url === "string" ? req.url : "/";
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  return path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…[cắt]` : path;
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

/**
 * Ghi một bản ghi truy cập khi phản hồi xong/kết nối đóng. Logger và ngữ cảnh lấy LÚC GHI (scope/requestId do middleware
 * đầu tiên của Medusa gắn sau khi hook server đã chạy); không có logger container → `fallback`.
 */
function trackAccess(req: ReqLike, res: ResLike, ctx: () => LogContext, fallback: AppLogger | null): void {
  const path = pathOf(req);
  if (SKIP.has(path)) return;
  const start = process.hrtime.bigint();
  let done = false;
  const finish = (aborted: boolean) => {
    if (done) return;
    done = true;
    try {
      const logger = containerLogger(req) ?? fallback;
      if (logger === null) return;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      runWithLogContext(ctx(), () =>
        logger.emit(res.statusCode >= 500 ? "error" : "info", "http.server.request", {
          "http.request.method": req.method,
          "url.path": path,
          "http.response.status_code": res.statusCode,
          duration_ms: Math.round(durationMs * 1000) / 1000,
          ...(aborted && { "http.aborted": true }),
        }),
      );
    } catch {
      // Log truy cập không bao giờ làm hỏng request/tiến trình.
    }
  };
  res.once("finish", () => finish(false));
  res.once("close", () => finish(res.writableFinished !== true));
}

export function requestLogContext(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction): void {
  const marks = req as unknown as Record<symbol, unknown>;
  const span = marks[SPAN];
  const ctx = { trace_id: traceIdOf(req), span_id: typeof span === "string" ? span : newSpanId() };
  if (marks[TRACKED] !== true)
    trackAccess(req as unknown as ReqLike, res as unknown as ResLike, () => ctx, null);
  runWithLogContext(ctx, () => next());
}

export interface HttpModuleLike {
  createServer: (...args: never[]) => unknown;
}

/** Theo dõi một request thô ở mức server (gọi trước mọi middleware). Một lần cho mỗi request. Không bao giờ ném. */
export function trackRawRequest(req: unknown, res: unknown, fallback: AppLogger): void {
  try {
    const marks = req as Record<symbol, unknown>;
    if (marks[TRACKED] === true) return;
    const span_id = newSpanId();
    marks[SPAN] = span_id;
    marks[TRACKED] = true;
    trackAccess(req as ReqLike, res as ResLike, () => ({ trace_id: traceIdOf(req), span_id }), fallback);
  } catch {
    // bỏ qua: không ảnh hưởng xử lý request
  }
}

/**
 * Request-target server chấp nhận (T-145): origin-form (`/…`) hoặc `OPTIONS *` (RFC 9112 §3.2). Dạng tuyệt đối
 * (`http://host/admin/…`, chỉ dành cho proxy) và mọi dạng khác bị từ chối TRƯỚC Express — Express/Medusa định tuyến theo
 * pathname đã parse nên request-target tuyệt đối từng lách được cổng RBAC/audit khớp chuỗi thô.
 */
export function isAcceptedRequestTarget(method: unknown, target: unknown): boolean {
  if (typeof target !== "string") return false;
  if (target.startsWith("/")) return true;
  return target === "*" && typeof method === "string" && method.toUpperCase() === "OPTIONS";
}

interface RawReq {
  method?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  requestId?: unknown;
}
interface RawRes {
  statusCode: number;
  setHeader(name: string, value: string | number): unknown;
  end(body?: string): unknown;
  destroy?: () => unknown;
}

/** 400 problem+json cho request-target bị từ chối; mã tham chiếu theo `x-request-id` hợp lệ như Medusa. Không ném. */
function rejectRequestTarget(req: RawReq, res: RawRes): void {
  try {
    const header = req.headers?.["x-request-id"];
    if (req.requestId === undefined && typeof header === "string") req.requestId = header;
    const body = JSON.stringify({
      type: "about:blank",
      title: "Request-target không hợp lệ: chỉ nhận đường dẫn bắt đầu bằng '/'",
      status: 400,
      code: "INVALID_REQUEST_TARGET",
      errors: [],
      trace_id: traceIdOf(req),
    });
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  } catch {
    try {
      res.destroy?.();
    } catch {
      // không còn cách trả lời — bỏ qua, không làm sập tiến trình
    }
  }
}

/** Sự kiện server mang (req, res) mới tới listener ứng dụng (`checkContinue` thay `request` khi có listener riêng). */
const REQUEST_EVENTS = new Set<unknown>(["request", "checkContinue"]);

function shouldReject(req: unknown): boolean {
  if (typeof req !== "object" || req === null) return false;
  try {
    const r = req as RawReq;
    return !isAcceptedRequestTarget(r.method, r.url);
  } catch {
    return true; // req đọc không được (getter ném) — đóng an toàn: không chuyển cho ứng dụng
  }
}

/**
 * Bọc `emit` của server: MỌI listener `request` (Express app truyền vào `createServer`, kể cả listener gắn sau) chỉ được
 * gọi khi request-target hợp lệ; request bị từ chối vẫn được ghi log truy cập rồi trả 400, listener gốc KHÔNG chạy.
 * `upgrade`/`connect` không đi qua đây (Node chỉ phát `request` cho upgrade khi không có listener `upgrade`).
 */
function guardServerRequests(server: unknown, fallback: AppLogger): void {
  const s = server as { emit?: unknown };
  if (typeof s.emit !== "function") return;
  const originalEmit = s.emit as (this: unknown, event: unknown, ...args: unknown[]) => boolean;
  s.emit = function (this: unknown, event: unknown, ...args: unknown[]): boolean {
    if (REQUEST_EVENTS.has(event)) {
      const [req, res] = args;
      trackRawRequest(req, res, fallback);
      if (shouldReject(req)) {
        rejectRequestTarget(req as RawReq, res as RawRes);
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}

/**
 * Bọc `http.createServer` (module `node:http` dùng chung — Medusa/Express gọi `http.createServer` của cùng module) để mọi
 * server tạo sau đó: (1) theo dõi log truy cập TRƯỚC mọi middleware; (2) từ chối request-target không phải origin-form
 * (T-145). Idempotent; trả `false` nếu đã cài. Mọi bước try/catch — lỗi trong hook không làm hỏng server.
 */
export function installAccessLogServerHook(fallback: AppLogger, mod?: HttpModuleLike): boolean {
  try {
    const m = mod ?? (createRequire(__filename)("node:http") as HttpModuleLike);
    const original = m.createServer;
    if ((original as unknown as Record<symbol, unknown>)[HOOKED] === true) return false;
    const wrapped = function (this: unknown, ...args: never[]): unknown {
      const server = original.apply(this, args);
      try {
        guardServerRequests(server, fallback);
      } catch {
        // server lạ — bỏ qua hook, server vẫn chạy
      }
      return server;
    };
    (wrapped as unknown as Record<symbol, unknown>)[HOOKED] = true;
    m.createServer = wrapped;
    return true;
  } catch {
    return false;
  }
}
