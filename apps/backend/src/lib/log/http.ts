import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { traceIdOf } from "../errors/trace";
import { isAppLogger, newSpanId, runWithLogContext, type LogContext } from "./logger";

/**
 * Ngữ cảnh log theo request + log truy cập (BASE-ERR-006, T-090) — middleware toàn cục (`matcher: "/"`, Medusa xếp nhóm
 * global lên đầu các middleware của dự án):
 *  - `trace_id` = mã tham chiếu request (cùng mã trả trong problem+json, `lib/errors/trace.ts`), `span_id` mới cho request;
 *    mọi log sau đó trong request (route, workflow, handler lỗi) tự mang hai trường này qua AsyncLocalStorage;
 *  - khi phản hồi xong/kết nối đóng: một bản ghi `http.server.request` — method, ĐƯỜNG DẪN KHÔNG query (query có thể chứa
 *    token/PII), cắt tối đa `MAX_PATH` ký tự, status, thời gian; không IP, không header, không thân. Bỏ qua probe sức khoẻ.
 *
 * KHÔNG dùng `traceRequestHandler` của `@medusajs/medusa/commands/start` để bọc sớm hơn: gán nó bật nhánh
 * `findExpressRoutePath` của Medusa 2.22.1 (`layer.match`/`url.parse` không try/catch trong executor Promise) → URL mã hoá
 * hỏng (`/auth/user/%FF`) hoặc dạng tuyệt đối làm sập tiến trình (unhandledRejection). Giới hạn đã biết: request bị
 * middleware lõi chặn TRƯỚC middleware này (vd thiếu publishable key ở /store) không có log truy cập của dự án.
 */

const SKIP = new Set(["/health", "/x/health", "/x/readyz"]);
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

function trackAccess(req: ReqLike, res: ResLike, ctx: LogContext): void {
  const path = pathOf(req);
  if (SKIP.has(path)) return;
  let logger: unknown;
  try {
    logger = req.scope?.resolve(ContainerRegistrationKeys.LOGGER);
  } catch {
    return;
  }
  if (!isAppLogger(logger)) return;
  const start = process.hrtime.bigint();
  let done = false;
  const finish = (aborted: boolean) => {
    if (done) return;
    done = true;
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
  const ctx = { trace_id: traceIdOf(req), span_id: newSpanId() };
  trackAccess(req as unknown as ReqLike, res as unknown as ResLike, ctx);
  runWithLogContext(ctx, () => next());
}
