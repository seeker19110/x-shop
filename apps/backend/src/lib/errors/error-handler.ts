import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getHttpResponseFromError } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { zodErrors, type ProblemError } from "../http/problem";
import { traceIdOf } from "./trace";

/**
 * Handler lỗi toàn cục của HTTP backend (BASE-ERR-002/003, T-088) — thay `errorHandler()` mặc định của Medusa qua
 * `defineMiddlewares({ errorHandler })`, áp cho MỌI route (tùy biến và native) mà lỗi được ném ra thay vì tự trả phản hồi.
 * Route đã tự map lỗi nghiệp vụ (checkout, đổi trả, đối soát, giao vận…) không đi qua đây — mã lỗi của chúng giữ nguyên.
 *
 * - Mã HTTP theo ánh xạ của Medusa (`getHttpResponseFromError`: 400/401/403/404/409/422/500) — không đổi hành vi client
 *   native; thêm: lỗi zod thô → 400 `VALIDATION` có `errors[]` (Medusa trả 500), lỗi multer → 400/413.
 * - Thân `application/problem+json` (RFC 9457) có `code` + `trace_id`; giữ `message` (= `detail`) vì client Medusa
 *   (js-sdk, Admin) đọc khoá này.
 * - 5xx: thông điệp chung, không stack/đường dẫn/SQL/tên bảng/phiên bản; đầy đủ (stack) chỉ ở log server kèm `trace_id`.
 *   4xx: giữ thông điệp của lỗi trừ khi nó đến từ Postgres (Medusa chép tên bảng/cột vào) hoặc trông như lộ nội bộ.
 * - Phản hồi đã gửi một phần (`headersSent`) → ghi log rồi để Express đóng kết nối (`next(err)`).
 */

export interface HttpProblem {
  status: number;
  body: {
    type: "about:blank";
    title: string;
    status: number;
    code: string;
    detail: string;
    message: string;
    trace_id: string;
    errors?: ProblemError[];
  };
}

const TITLES: Record<number, string> = {
  400: "Yêu cầu không hợp lệ",
  401: "Chưa xác thực",
  403: "Không có quyền thực hiện thao tác này",
  404: "Không tìm thấy",
  409: "Xung đột với yêu cầu khác, vui lòng thử lại",
  413: "Dữ liệu gửi lên quá lớn",
  415: "Kiểu nội dung không được hỗ trợ",
  422: "Dữ liệu chưa hợp lệ",
  429: "Bạn thao tác quá nhanh, vui lòng thử lại sau",
  500: "Không thể xử lý yêu cầu lúc này",
  503: "Dịch vụ tạm thời gián đoạn, vui lòng thử lại sau",
};

const CODES: Record<number, string> = {
  400: "INVALID_DATA",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
};

const titleOf = (status: number) => TITLES[status] ?? (status >= 500 ? TITLES[500]! : TITLES[400]!);

/**
 * Dấu hiệu thông điệp lộ nội bộ: stack, đường dẫn file, câu SQL, thông báo Postgres, địa chỉ/cổng hạ tầng. Lớp đỡ thứ hai
 * cho 4xx (lớp chính: lỗi Postgres luôn dùng thông điệp chung).
 */
export const INTERNAL_LEAK =
  /(Traceback|\n\s*at |\bat .*\.(js|ts|mjs|cjs):\d|node_modules|\/home\/|\/var\/|\/usr\/|\/app\/|[A-Z]:\\|\bSELECT\b|\bINSERT\s+INTO\b|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b|\brelation "|\bcolumn "|\btable\b|\bconstraint\b|ECONN|ETIMEDOUT|EAI_AGAIN|\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b|medusa|knex|mikro-?orm|postgres)/i;

const MAX_DETAIL = 500;

function isPostgresError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    /^[0-9A-Z]{5}$/.test(e.code) &&
    ("severity" in e || "table" in e || "routine" in e || "schema" in e)
  );
}

function isZodError(err: unknown): err is { issues: Array<{ path: PropertyKey[]; message: string }> } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

interface HttpLikeError {
  statusCode?: unknown;
  status?: unknown;
  expose?: unknown;
  type?: unknown;
  message?: unknown;
}

/** Lỗi kiểu `http-errors` (body-parser, express): có statusCode 4xx/5xx và cờ `expose`. */
function httpErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as HttpLikeError;
  const status =
    typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  if (status === null || typeof e.expose !== "boolean") return null;
  return status >= 400 && status <= 599 ? status : null;
}

function safeDetail(message: unknown, status: number): string {
  if (typeof message !== "string" || message.trim() === "" || message.length > MAX_DETAIL)
    return titleOf(status);
  return INTERNAL_LEAK.test(message) ? titleOf(status) : message;
}

/** Ánh xạ thuần lỗi → problem (để test không cần HTTP). */
export function toHttpProblem(err: unknown, traceId: string): HttpProblem {
  let status = 500;
  let code: string | undefined;
  let detail: string | undefined;
  let errors: ProblemError[] | undefined;

  const httpStatus = httpErrorStatus(err);
  if (isZodError(err)) {
    status = 400;
    code = "VALIDATION";
    errors = zodErrors(err.issues);
    detail = TITLES[422];
  } else if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "MulterError") {
    status = (err as { code?: unknown }).code === "LIMIT_FILE_SIZE" ? 413 : 400;
  } else if (httpStatus !== null) {
    status = httpStatus;
    const t = (err as HttpLikeError).type;
    if (t === "entity.parse.failed") detail = "Thân yêu cầu không phải JSON hợp lệ";
    else if (t === "entity.too.large") detail = TITLES[413];
    else if (status < 500) detail = safeDetail((err as HttpLikeError).message, status);
  } else {
    try {
      const mapped = getHttpResponseFromError(err) as {
        statusCode: number;
        body: { code?: unknown; message?: unknown };
      };
      status = mapped.statusCode;
      if (status < 500) {
        if (typeof mapped.body.code === "string" && /^[a-z_]{1,64}$/.test(mapped.body.code))
          code = mapped.body.code;
        detail = isPostgresError(err) ? titleOf(status) : safeDetail(mapped.body.message, status);
      }
    } catch {
      // Bộ định dạng lỗi của Medusa tự ném (vd lỗi Postgres thiếu trường) → coi là lỗi máy chủ.
      status = 500;
    }
  }

  if (status >= 500) {
    code = "INTERNAL";
    detail = titleOf(status);
    errors = undefined;
  }
  const finalDetail = detail ?? titleOf(status);
  return {
    status,
    body: {
      type: "about:blank",
      title: titleOf(status),
      status,
      code: code ?? CODES[status] ?? "ERROR",
      detail: finalDetail,
      message: finalDetail,
      trace_id: traceId,
      ...(errors && errors.length > 0 && { errors }),
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "lỗi không rõ (không tuần tự hoá được)";
  }
}

interface LoggerLike {
  error(msg: string): void;
  info(msg: string): void;
}

function loggerOf(req: MedusaRequest): LoggerLike {
  try {
    return req.scope.resolve<LoggerLike>(ContainerRegistrationKeys.LOGGER);
  } catch {
    return console;
  }
}

/**
 * Ghi log lỗi máy chủ đầy đủ (stack) kèm `trace_id` — cùng mã với phản hồi trả cho client. Dùng chung cho handler toàn cục
 * và các bộ map lỗi theo route (checkout, đổi trả, đối soát, giao vận). Trả `trace_id`.
 */
export function logServerError(req: MedusaRequest, tag: string, error: unknown): string {
  const traceId = traceIdOf(req);
  loggerOf(req).error(`[${tag}] ${req.method} ${req.path} trace_id=${traceId}: ${describeError(error)}`);
  return traceId;
}

export function xErrorHandler(
  err: unknown,
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const traceId = traceIdOf(req);
  if (res.headersSent) {
    logServerError(req, "http", err);
    next(err);
    return;
  }
  const problem = toHttpProblem(err, traceId);
  if (problem.status >= 500) logServerError(req, "http", err);
  else
    loggerOf(req).info(
      `[http] ${problem.status} ${problem.body.code} ${req.method} ${req.path} trace_id=${traceId}`,
    );
  res
    .status(problem.status)
    .setHeader("Content-Type", "application/problem+json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .send(JSON.stringify(problem.body));
}
