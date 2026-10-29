import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getHttpResponseFromError } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { zodErrors, type ProblemError } from "../http/problem";
import { INVENTORY_CONFLICT_RETRY, inventoryGuardKind } from "../inventory/guard";
import { redactLog } from "../log/redact";
import { traceIdOf } from "./trace";

/**
 * Handler lỗi toàn cục của HTTP backend (BASE-ERR-002/003, T-088) — thay `errorHandler()` mặc định của Medusa qua
 * `defineMiddlewares({ errorHandler })`, áp cho MỌI route (tùy biến và native) mà lỗi được ném ra thay vì tự trả phản hồi.
 * Route đã tự map lỗi nghiệp vụ (checkout, đổi trả, đối soát, giao vận…) không đi qua đây — mã lỗi của chúng giữ nguyên.
 *
 * - Mã HTTP theo ánh xạ của Medusa (`getHttpResponseFromError`: 400/401/403/404/409/422/500) — không đổi hành vi client
 *   native; thêm: lỗi zod thô → 400 `VALIDATION` có `errors[]` (Medusa trả 500), lỗi multer → 400/413, tham số đường
 *   dẫn mã hoá hỏng (URIError của Express) → 400 `INVALID_PATH` (Medusa trả 500), vi phạm hàng rào tồn kho phía DB
 *   (T-185): vượt tồn (`x_inventory_level_stock_guard`) → 409 `INSUFFICIENT_STOCK`, số giữ bị ghi đè đồng thời
 *   (`x_inventory_reserved_drift`) → 409 `INVENTORY_CONFLICT_RETRY` kèm `Retry-After` (Medusa trả 500 cho cả hai).
 * - Thân `application/problem+json` (RFC 9457) có `code` + `trace_id`; giữ `message` (= `detail`) vì client Medusa
 *   (js-sdk, Admin) đọc khoá này.
 * - 5xx: thông điệp chung, không stack/đường dẫn/SQL/tên bảng/phiên bản; đầy đủ (stack) chỉ ở log server kèm `trace_id`.
 *   4xx: giữ thông điệp của lỗi trừ khi nó đến từ Postgres (Medusa chép tên bảng/cột vào), trông như lộ nội bộ, hoặc là
 *   thông điệp `dbErrorMapper` của Medusa chép giá trị người gửi (unique ở 400, FK ở 404 → thông điệp chung giữ tên trường, T-157)
 *   hoặc một dạng nghiệp vụ Medusa nội suy giá trị người gửi (email, khoá idempotency, mã khuyến mãi, tiêu đề, handle…, T-159).
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

/** `Retry-After` mặc định (giây) cho 429 không có giá trị riêng. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

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

/** Trần độ dài thông điệp mà bộ nhận dạng `dbErrorMapper` chịu phân tích (dài hơn → vẫn thông điệp chung, không tên trường). */
const MAX_DB_MESSAGE = 4096;
const FIELD_NAME = /^[A-Za-z_][\w.]{0,63}$/;
const UNIQUE_TAIL = ", already exists.";
const FK_HEAD = "You tried to set relationship ";
const FK_TAIL = ", but such entity does not exist";
const DUPLICATE_REASON = "Giá trị đã tồn tại";
const MISSING_REF_REASON = "Tham chiếu không tồn tại";

export interface DbValueMessage {
  detail: string;
  reason: string;
  fields: string[];
}

/** Tên trường của `k: v<sep>k2: v2`; một tên không hợp lệ → `[]`. Giá trị không chứa `,` (Medusa tách `detail` theo dấu phẩy) nhưng có thể chứa `: `, xuống dòng, Unicode. */
function fieldsOf(body: string, sep: string): string[] {
  const pieces = body.split(sep, 33);
  if (pieces.length > 32) return [];
  const out: string[] = [];
  for (const piece of pieces) {
    const i = piece.indexOf(": ");
    const k = i === -1 ? "" : piece.slice(0, i);
    if (!FIELD_NAME.test(k)) return [];
    out.push(k);
  }
  return out;
}

function dbValueResult(reason: string, fields: string[]): DbValueMessage {
  return {
    reason,
    fields,
    detail: fields.length === 0 ? reason : `${reason} (trường: ${fields.join(", ")})`,
  };
}

/**
 * Thông điệp của Medusa `dbErrorMapper` chép GIÁ TRỊ người gửi (D-097, T-157): unique → `<Bảng> with k: v, k2: v2,
 * already exists.`; FK → `You tried to set relationship k: v,k2: v2, but such entity does not exist`. Trả thông điệp
 * chung giữ tên trường, bỏ giá trị và tên bảng. Chỉ `indexOf`/`endsWith`/`split` có trần — tuyến tính, không regex backtrack.
 * Hình dạng đúng mà tên trường không hợp lệ → vẫn thông điệp chung (không tên trường): đóng an toàn.
 */
export function dbValueMessage(message: unknown, status: number): DbValueMessage | null {
  if (typeof message !== "string") return null;
  const tooLong = message.length > MAX_DB_MESSAGE;
  if (status === 400 && message.endsWith(UNIQUE_TAIL)) {
    const at = message.indexOf(" with ");
    if (at < 1) return null;
    const fields = tooLong ? [] : fieldsOf(message.slice(at + 6, message.length - UNIQUE_TAIL.length), ", ");
    return dbValueResult(DUPLICATE_REASON, fields);
  }
  if (status === 404 && message.startsWith(FK_HEAD) && message.endsWith(FK_TAIL)) {
    const fields = tooLong
      ? []
      : fieldsOf(message.slice(FK_HEAD.length, message.length - FK_TAIL.length), ",");
    return dbValueResult(MISSING_REF_REASON, fields);
  }
  return null;
}

/**
 * Một dạng thông điệp 4xx của Medusa 2.22.1 nội suy GIÁ TRỊ người gửi (T-159, D-097): `head` + giá trị + [`mid` + giá
 * trị] + `tail`. Chỉ khớp bằng `startsWith`/`endsWith`/`indexOf` — không regex.
 */
interface EchoForm {
  head: string;
  mid?: string;
  tail?: string;
  reason: string;
  field?: string;
}

const OPTION_COMBO_REASON = "Tổ hợp tuỳ chọn của biến thể đã tồn tại";
const OPTION_ASSIGN_REASON = "Tuỳ chọn của sản phẩm không hợp lệ";
const PROMO_REASON = "Mã khuyến mãi không hợp lệ";
const AUTH_IDENTITY_REASON = "Không tìm thấy danh tính xác thực";
const REFUND_KEY_REASON = "Khoá idempotency của hoàn tiền đã được dùng";

/**
 * Các dạng (đường dẫn nguồn: `node_modules/@medusajs/<gói>/dist/…`, bản 2.22.1).
 * Ưu tiên PII/giá trị nhạy cảm: email (khách, tài khoản, `entity_id` của emailpass), khoá idempotency, mã khuyến mãi,
 * tiêu đề/handle do admin nhập. Id hệ thống (`prod_…`) không thuộc danh sách này.
 */
const ECHO_FORMS: readonly EchoForm[] = [
  // product-module-service.js
  {
    head: "Variant (",
    tail: ") with provided options already exists.",
    reason: OPTION_COMBO_REASON,
    field: "options",
  },
  {
    head: 'Variant "',
    mid: '" has same combination of option values as "',
    tail: '".',
    reason: OPTION_COMBO_REASON,
    field: "options",
  },
  {
    head: 'Product "',
    mid: '" has duplicate option assignments: [',
    tail: "]",
    reason: OPTION_ASSIGN_REASON,
    field: "options",
  },
  {
    head: 'Product "',
    mid: '" has variants with missing options: [',
    tail: "]",
    reason: OPTION_ASSIGN_REASON,
    field: "options",
  },
  {
    head: "Product has ",
    mid: " option values but there were ",
    tail: ".",
    reason: OPTION_ASSIGN_REASON,
    field: "options",
  },
  {
    head: "Invalid product handle '",
    tail: "'. It must contain URL safe characters",
    reason: "Handle sản phẩm không hợp lệ",
    field: "handle",
  },
  {
    head: 'Value "',
    tail: '" is assigned a rank but is not defined in the list of values.',
    reason: "Giá trị có thứ hạng nhưng không nằm trong danh sách",
    field: "values",
  },
  // product/utils/resolve-allowed-option-values.js
  {
    head: "Option value ",
    mid: " does not exist for option ",
    reason: "Giá trị tuỳ chọn không tồn tại",
    field: "options",
  },
  // payment-module.js (cả hai dạng "already exists … for a different amount" và "still in progress")
  { head: "A refund with idempotency key ", reason: REFUND_KEY_REASON, field: "idempotency_key" },
  // draft-order/utils/validation.js, cart/steps/get-promotion-codes-to-apply.js
  { head: 'Promotion code "', tail: '" not found', reason: PROMO_REASON, field: "promo_codes" },
  { head: 'Promotion code "', tail: '" is not active', reason: PROMO_REASON, field: "promo_codes" },
  // số nhiều (getMessageByCount): `Promotion codes "A", "B" not found` / `... are not active`
  { head: 'Promotion codes "', tail: '" not found', reason: PROMO_REASON, field: "promo_codes" },
  { head: 'Promotion codes "', tail: '" are not active', reason: PROMO_REASON, field: "promo_codes" },
  { head: "The promotion code ", tail: " is invalid", reason: PROMO_REASON, field: "promo_codes" },
  // auth-module.js (`entity_id` của emailpass = email)
  {
    head: 'AuthIdentity with entity_id "',
    tail: '" not found',
    reason: AUTH_IDENTITY_REASON,
    field: "entity_id",
  },
  {
    head: 'ProviderIdentity with entity_id "',
    tail: '" not found',
    reason: AUTH_IDENTITY_REASON,
    field: "entity_id",
  },
  {
    head: 'Multiple authIdentities found for entity_id "',
    tail: '"',
    reason: AUTH_IDENTITY_REASON,
    field: "entity_id",
  },
  {
    head: "Provider identity with entity_id ",
    mid: " and provider ",
    tail: " not found",
    reason: AUTH_IDENTITY_REASON,
    field: "entity_id",
  },
  // core-flows: find-sales-channel.js, update-line-item-in-cart.js, transfer đơn.
  // (`Key <k> already exists in app metadata` bị bỏ: nguồn ném `new Error` thường → 500, không bao giờ tới nhánh 4xx.)
  {
    head: "Unable to assign cart to disabled Sales Channel: ",
    reason: "Kênh bán hàng đang tắt",
    field: "sales_channel_id",
  },
  { head: "Line item ", tail: " has no unit price", reason: "Dòng hàng chưa có đơn giá" },
  {
    head: "Cannot transfer order: ",
    reason: "Không thể chuyển đơn cho tài khoản khách này",
    field: "customer_id",
  },
  // user-module.js
  {
    head: "User account for following email(s) already exist: ",
    reason: "Email đã có tài khoản",
    field: "email",
  },
];

/** Trần độ dài để tìm `mid` bằng `indexOf` (dài hơn: `head`+`tail` khớp là đủ — đóng an toàn, vẫn thông điệp chung). */
const MAX_ECHO_MESSAGE = 4096;

/**
 * Thông điệp nghiệp vụ 4xx của Medusa chép giá trị người gửi (T-159): trả thông điệp chung, giữ tên trường (nếu có),
 * bỏ giá trị. Status/mã do `toHttpProblem` giữ nguyên. Thông điệp của chính dự án (tiếng Việt) không khớp dạng nào.
 */
export function echoedValueMessage(message: unknown): DbValueMessage | null {
  if (typeof message !== "string") return null;
  for (const f of ECHO_FORMS) {
    if (!message.startsWith(f.head)) continue;
    const tailLen = f.tail?.length ?? 0;
    if (message.length < f.head.length + (f.mid?.length ?? 0) + tailLen) continue;
    if (f.tail !== undefined && !message.endsWith(f.tail)) continue;
    if (f.mid !== undefined && message.length <= MAX_ECHO_MESSAGE) {
      const at = message.indexOf(f.mid, f.head.length);
      if (at === -1 || at + f.mid.length > message.length - tailLen) continue;
    }
    return dbValueResult(f.reason, f.field === undefined ? [] : [f.field]);
  }
  return null;
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
  if (err instanceof URIError || (err as { name?: unknown } | null)?.name === "URIError") {
    // Express không giải mã được tham số đường dẫn (`%E0%A4%A`…) → 400 (Medusa mặc định trả 500) — T-085.
    status = 400;
    code = "INVALID_PATH";
    detail = "Đường dẫn không hợp lệ";
  } else if (isZodError(err)) {
    status = 400;
    code = "VALIDATION";
    errors = zodErrors(err.issues);
    detail = TITLES[422];
  } else if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "MulterError") {
    status = (err as { code?: unknown }).code === "LIMIT_FILE_SIZE" ? 413 : 400;
  } else if (inventoryGuardKind(err) === "stock") {
    // Hàng rào tồn kho phía DB (T-185) từ chối lúc commit (vd route native giảm tồn dưới số đang giữ, giữ hàng vượt tồn)
    // — xung đột dữ liệu có nghĩa nghiệp vụ, không phải lỗi máy chủ. Không chép thông điệp Postgres (id, số lượng).
    status = 409;
    code = "INSUFFICIENT_STOCK";
    detail = "Tồn kho không đủ cho số đang giữ cho đơn — tải lại số tồn rồi thử lại";
  } else if (inventoryGuardKind(err) === "drift") {
    // Số giữ bị một ghi đồng thời ghi đè (T-185) — ghi đã bị hủy, gửi lại sẽ đọc số mới.
    status = 409;
    code = INVENTORY_CONFLICT_RETRY;
    detail = "Tồn kho vừa được cập nhật đồng thời — vui lòng thử lại";
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
        const dbMsg = isPostgresError(err)
          ? null
          : (dbValueMessage(mapped.body.message, status) ?? echoedValueMessage(mapped.body.message));
        if (dbMsg !== null) {
          detail = dbMsg.detail;
          errors = dbMsg.fields.map((param) => ({ param, reason: dbMsg.reason }));
        } else detail = isPostgresError(err) ? titleOf(status) : safeDetail(mapped.body.message, status);
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
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    // Che TỪNG trường trước khi tuần tự hoá: JSON.stringify thoát `"` thành `\"` và làm mẫu SQL/PII không còn khớp (T-151).
    return JSON.stringify(redactLog(error)) ?? String(error);
  } catch {
    return "lỗi không rõ (không tuần tự hoá được)";
  }
}

interface LoggerLike {
  error(msg: string, error?: Error): void;
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
 * Ghi log lỗi máy chủ kèm `trace_id` — cùng mã với phản hồi trả cho client. Dùng chung cho handler toàn cục và các bộ map
 * lỗi theo route (checkout, đổi trả, đối soát, giao vận). Error được chuyển nguyên cho logger (tham số thứ hai) → logger
 * của dự án ghi `exception.type/message/stacktrace` kèm chuỗi `cause` (T-090, lib/log/logger.ts). Trả `trace_id`.
 */
export function logServerError(req: MedusaRequest, tag: string, error: unknown): string {
  const traceId = traceIdOf(req);
  loggerOf(req).error(
    `[${tag}] ${req.method} ${req.path} trace_id=${traceId}: ${describeError(error)}`,
    error instanceof Error ? error : undefined,
  );
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
  // 429 của chính ta luôn kèm `Retry-After` (T-093, RFC 6585 §4): lỗi 429 lọt tới handler toàn cục mà route chưa đặt
  // giá trị riêng → mặc định thận trọng.
  if (problem.status === 429 && res.getHeader("Retry-After") === undefined)
    res.setHeader("Retry-After", String(DEFAULT_RETRY_AFTER_SECONDS));
  if (problem.body.code === INVENTORY_CONFLICT_RETRY && res.getHeader("Retry-After") === undefined)
    res.setHeader("Retry-After", "1");
  res
    .status(problem.status)
    .setHeader("Content-Type", "application/problem+json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .send(JSON.stringify(problem.body));
}
