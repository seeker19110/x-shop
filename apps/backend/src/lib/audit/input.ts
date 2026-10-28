import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { normalizeMethod } from "../admin-security/route-match";
import { rawRequestPath } from "../http/request-path";
import {
  decideDenyAudit,
  DENY_AUDIT_THROTTLE,
  denyBucket,
  isRecordedOccurrence,
  type WindowCounter,
} from "./deny-throttle";
import { SECURITY_EVENTS, type SecurityEventName } from "./events";
import { counterOf, ipGroupOf, parseJsonBody, resolveActor } from "./http";
import { hashIdentifier, recordAudit } from "./record";
import { maskFreeText } from "./sanitize";

/**
 * Audit đầu vào bị từ chối (T-175, SEC-LOG-001 "lỗi validate đầu vào", "lỗi deserialize") cho MỌI route:
 *   - `input.validation_failed`: schema từ chối — validator native của Medusa (`validateAndTransformBody/Query` ném
 *     `MedusaError` `invalid_data` "Invalid request: …"), lỗi zod thô tới handler lỗi, và phản hồi 400/422 mang mã
 *     `VALIDATION` (quy ước của dự án cho đầu vào sai — zod trong route `/admin/x/*`, `CheckoutError`/`ReturnsError`) hoặc
 *     `INVALID_CHARACTERS` (NUL ở đường dẫn/query/thân — `rejectNulBytes`);
 *   - `input.deserialize_failed`: thân không giải mã được (body-parser: JSON hỏng, charset/encoding không hỗ trợ) hoặc
 *     tham số đường dẫn mã hoá hỏng (`URIError` của Express → 400 `INVALID_PATH`).
 *
 * Hai điểm bắt, MỘT dòng mỗi request (cờ trên request):
 *   1. `inputAuditTrail` (middleware toàn cục, đăng ký cùng `requestLogContext`) quan sát phản hồi: lúc `finish` ghi nếu
 *      handler lỗi đã phân loại lỗi của request, hoặc status 400/422 kèm mã ở trên;
 *   2. `withInputAudit(errorHandler)` bọc handler lỗi toàn cục: phân loại lỗi (`classifyInputError`); body-parser của
 *      Medusa chạy TRƯỚC mọi middleware của dự án → lỗi deserialize đi thẳng tới handler lỗi mà (1) chưa được gắn → (2)
 *      tự ghi lúc `finish`.
 * Không ghi thân, thông điệp lỗi (Medusa chép giá trị nhập vào thông điệp) hay query; chỉ status, mã lỗi, nguồn phân loại,
 * tên tham số lỗi (`errors[].param` đã lọc), route. Đích = `http_route` / `<METHOD> <mẫu route Express>` (không có mẫu →
 * pathname đã che PII, ≤ 200 ký tự). Chống ngập, hai tầng:
 *   - gộp theo (actor hoặc nguồn IP, sự kiện, mã lỗi) như `deny-throttle.ts` (ghi lần 1, 10, 100…) — KHÔNG theo method
 *     hay đường dẫn (client chọn tuỳ ý: đổi method/đường dẫn mỗi lần là lách được);
 *   - trần chung cho nguồn VÔ DANH theo sự kiện: tối đa `INPUT_ANON_GLOBAL_CAP` dòng (đã qua gộp nguồn) mỗi cửa sổ trên
 *     toàn hệ thống (xoay nhiều IP không làm ngập); dòng thứ trần + 1 là dòng ĐÁNH DẤU (`changes.global_cap.mark:
 *     reached`), sau đó chỉ đếm; bộ đếm THÔ (mọi request vô danh bị từ chối, kể cả bị gộp nguồn) ghi thêm một dòng ở lần
 *     1000, 10000… của cửa sổ (`mark: milestone`, `occurrence` = số request thô).
 * Ghi audit lỗi → log lỗi (không PII), không ảnh hưởng request.
 */

/** Trần dòng `input.*` vô danh mỗi cửa sổ gộp (60 s), toàn hệ thống, theo sự kiện. */
export const INPUT_ANON_GLOBAL_CAP = 50;

export type InputRejectionKind = "validation" | "deserialize";

export interface InputRejection {
  kind: InputRejectionKind;
  /** Nguồn phân loại — từ vựng cố định (không chép chuỗi lạ). */
  cause: string;
}

/** Mã problem+json được coi là đầu vào bị schema/kiểm tra định dạng từ chối. */
export const VALIDATION_PROBLEM_CODES: readonly string[] = ["VALIDATION", "INVALID_CHARACTERS"];
const OBSERVED_STATUSES = new Set([400, 422]);

/** Loại lỗi body-parser (http-errors `type`) = thân không giải mã được. */
const DESERIALIZE_TYPES: Readonly<Record<string, string>> = {
  "entity.parse.failed": "body_parse",
  "charset.unsupported": "body_charset",
  "encoding.unsupported": "body_encoding",
};

/** Tiền tố thông điệp của `zodValidator` (Medusa 2.22.1 `@medusajs/framework/dist/zod/zod-helpers.js`). */
export const MEDUSA_VALIDATOR_PREFIX = "Invalid request: ";

/** Phân loại lỗi tới handler lỗi toàn cục; `null` = không phải lỗi đầu vào (nghiệp vụ, hệ thống…). Không ném. */
export function classifyInputError(err: unknown): InputRejection | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; type?: unknown; message?: unknown; issues?: unknown; expose?: unknown };
  if (err instanceof URIError || e.name === "URIError") return { kind: "deserialize", cause: "path_decode" };
  if (e.name === "ZodError" && Array.isArray(e.issues)) return { kind: "validation", cause: "zod" };
  if (typeof e.type === "string" && typeof e.expose === "boolean" && Object.hasOwn(DESERIALIZE_TYPES, e.type))
    return { kind: "deserialize", cause: DESERIALIZE_TYPES[e.type] as string };
  if (
    e.type === "invalid_data" &&
    typeof e.message === "string" &&
    e.message.startsWith(MEDUSA_VALIDATOR_PREFIX)
  )
    return { kind: "validation", cause: "medusa_schema" };
  return null;
}

interface InputAuditState {
  /** `inputAuditTrail` đã gắn quan sát cho request này. */
  observed: boolean;
  /** Phân loại từ handler lỗi (chính xác hơn mã phản hồi). */
  classified: InputRejection | null;
  /** Thân phản hồi lỗi đã giữ (chỉ khi status 400/422). */
  body: unknown;
  recorded: boolean;
}

const STATE = Symbol.for("x-shop.audit.input-state");
type WithState = MedusaRequest & { [STATE]?: InputAuditState };

function stateOf(req: MedusaRequest): InputAuditState {
  const r = req as WithState;
  r[STATE] ??= { observed: false, classified: null, body: null, recorded: false };
  return r[STATE];
}

const PROBLEM_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const PARAM_NAME = /^[A-Za-z0-9_.[\]*-]{1,64}$/;
const MAX_PARAMS = 10;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_\-/:.*]{0,199}$/;
const MAX_RESOURCE_PATH = 200;
export const INVALID_PATH_LABEL = "(đường dẫn không hợp lệ)";

function problemCodeOf(body: unknown): string | null {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" && PROBLEM_CODE.test(code) ? code : null;
}

/** Tên tham số lỗi từ `errors[].param` của problem+json (đã lọc ký tự) — không bao giờ `reason`/giá trị. */
function problemParamsOf(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  const out = new Set<string>();
  for (const e of errors) {
    const p = (e as { param?: unknown } | null)?.param;
    if (typeof p === "string" && PARAM_NAME.test(p)) out.add(p);
    if (out.size >= MAX_PARAMS) break;
  }
  return [...out];
}

/** Mẫu route Express đã khớp (vd `/admin/stores/:id`) hoặc pathname đã che PII; không parse được → nhãn cố định. */
export function inputResourceOf(req: MedusaRequest, rejection: InputRejection | null): string {
  const method = normalizeMethod(req.method);
  const pattern = (req as MedusaRequest & { route?: { path?: unknown } }).route?.path;
  if (typeof pattern === "string" && ROUTE_PATTERN.test(pattern)) return `${method} ${pattern}`;
  const pathname = rejection?.cause === "path_decode" ? null : rawRequestPath(req);
  if (pathname === null) return `${method} ${INVALID_PATH_LABEL}`;
  // Che từng đoạn (email/SĐT trong một đoạn) — che cả chuỗi thì mẫu email nuốt hết các đoạn quanh nó.
  const masked = pathname
    .split("/")
    .map((s) => maskFreeText(s))
    .join("/");
  return `${method} ${masked.length > MAX_RESOURCE_PATH ? `${masked.slice(0, MAX_RESOURCE_PATH)}…` : masked}`;
}

/** Bucket của bộ đếm chung vô danh theo sự kiện: `raw` = mọi request vô danh bị từ chối; `rows` = dòng đã qua gộp nguồn. */
function anonBucket(event: SecurityEventName, kind: "raw" | "rows"): string {
  return denyBucket({
    actorType: "global",
    actorId: null,
    method: "*",
    routeClass: `audit:${event}:anon_${kind}`,
    reason: "*",
  });
}

/** Mốc độ lớn đợt theo số request vô danh THÔ trong cửa sổ: 1000, 10000… (ghi bất kể trần/gộp nguồn). */
export function isAnonMilestone(raw: number | null): boolean {
  return raw !== null && raw >= 1000 && isRecordedOccurrence(raw);
}

/**
 * Trần chung theo số dòng đã qua gộp nguồn: ≤ trần → ghi; đúng trần + 1 → ghi MỘT dòng đánh dấu (`reached`); vượt nữa →
 * bỏ (chỉ đếm). Bộ đếm lỗi (`null`) → ghi (mất dấu vết tệ hơn thêm dòng).
 */
export function anonCapVerdict(rows: number | null): "record" | "reached" | "skip" {
  if (rows === null || rows <= INPUT_ANON_GLOBAL_CAP) return "record";
  return rows === INPUT_ANON_GLOBAL_CAP + 1 ? "reached" : "skip";
}

async function countOrNull(
  counter: WindowCounter,
  bucket: string,
  now: Date,
  onError: () => void,
): Promise<number | null> {
  try {
    return await counter(bucket, DENY_AUDIT_THROTTLE.windowMs, now);
  } catch {
    onError();
    return null;
  }
}

async function recordInputRejection(
  req: MedusaRequest,
  res: MedusaResponse,
  rejection: InputRejection,
  body: unknown,
): Promise<void> {
  const event: SecurityEventName =
    rejection.kind === "validation"
      ? SECURITY_EVENTS.INPUT_VALIDATION_FAILED
      : SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED;
  const status = res.statusCode;
  const errorCode = problemCodeOf(body);
  const ctx = (req as MedusaRequest & { auth_context?: { actor_id?: string; actor_type?: string } })
    .auth_context;
  const actor = resolveActor(null, ctx, (v) => hashIdentifier(req.scope, v));
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const now = new Date();
  const counter = counterOf(req);
  const onCounterError = () => logger.warn(`[audit] Bộ đếm gộp audit lỗi, vẫn ghi: ${event}`);
  const anonymous = actor.actor_id === null;
  // Vô danh: đếm THÔ mọi lần (kể cả lần bị gộp theo nguồn) — mốc 1000, 10000… phản ánh đúng độ lớn đợt.
  const raw = anonymous ? await countOrNull(counter, anonBucket(event, "raw"), now, onCounterError) : null;
  // Gộp theo actor đã xác thực, không có thì theo nguồn IP — không theo method/đường dẫn (client chọn, lách được).
  const decision = await decideDenyAudit(
    counter,
    {
      actorType: anonymous ? "ip" : actor.actor_type,
      actorId: actor.actor_id ?? ipGroupOf(req),
      method: "*",
      routeClass: `audit:${event}`,
      reason: errorCode ?? rejection.cause,
    },
    now,
    onCounterError,
  );
  let globalCap: { mark: "reached" | "milestone"; occurrence: number | null } | null = null;
  if (anonymous && isAnonMilestone(raw)) {
    globalCap = { mark: "milestone", occurrence: raw };
  } else {
    if (!decision.record) return;
    if (anonymous) {
      const verdict = anonCapVerdict(
        await countOrNull(counter, anonBucket(event, "rows"), now, onCounterError),
      );
      if (verdict === "skip") return;
      if (verdict === "reached") globalCap = { mark: "reached", occurrence: raw };
    }
  }
  const params = problemParamsOf(body);
  await recordAudit(
    req.scope,
    {
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      action: event,
      resource_type: "http_route",
      resource_id: inputResourceOf(req, rejection),
      outcome: "failure",
      changes: {
        status,
        error_code: errorCode,
        cause: rejection.cause,
        ...(params.length > 0 && { params }),
        ...(actor.pseudonymized && { actor_pseudonymized: true }),
        throttle: { occurrence: decision.occurrence, window_seconds: decision.window_seconds },
        ...(globalCap !== null && {
          global_cap: { cap: INPUT_ANON_GLOBAL_CAP, mark: globalCap.mark, occurrence: globalCap.occurrence },
        }),
      },
    },
    req,
  );
}

/** Quyết định lúc `finish` và ghi tối đa một lần cho request. Không bao giờ ném. */
function settle(req: MedusaRequest, res: MedusaResponse): void {
  try {
    const state = stateOf(req);
    if (state.recorded) return;
    let rejection = state.classified;
    if (rejection === null) {
      const code = problemCodeOf(state.body);
      if (!OBSERVED_STATUSES.has(res.statusCode) || code === null || !VALIDATION_PROBLEM_CODES.includes(code))
        return;
      rejection = { kind: "validation", cause: "problem_code" };
    }
    state.recorded = true;
    recordInputRejection(req, res, rejection, state.body).catch((e: unknown) => logFailure(req, e));
  } catch (e) {
    logFailure(req, e);
  }
}

function logFailure(req: MedusaRequest, e: unknown): void {
  try {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[audit] Không ghi được audit đầu vào bị từ chối: ${(e as Error).message}`);
  } catch {
    // không có logger — bỏ qua, không làm hỏng tiến trình
  }
}

/** Gắn quan sát (một lần mỗi request): giữ thân phản hồi lỗi để đọc `code`/`errors[].param`, quyết định lúc `finish`. */
function observe(req: MedusaRequest, res: MedusaResponse): void {
  const state = stateOf(req);
  if (state.observed) return;
  state.observed = true;
  const keep = () =>
    state.body === null && (state.classified !== null || OBSERVED_STATUSES.has(res.statusCode));
  const w = res as unknown as { json: (b: unknown) => MedusaResponse; send: (b: unknown) => MedusaResponse };
  const originalJson = w.json.bind(res);
  const originalSend = w.send.bind(res);
  w.json = (b: unknown) => {
    if (keep()) state.body = b;
    return originalJson(b);
  };
  w.send = (b: unknown) => {
    if (keep()) state.body = parseJsonBody(b);
    return originalSend(b);
  };
  res.once("finish", () => settle(req, res));
}

/**
 * Middleware toàn cục — giữ thân phản hồi lỗi 400/422 (đối tượng của `res.json` hoặc chuỗi JSON của `res.send`) để đọc
 * `code`/`errors[].param`, rồi quyết định lúc `finish`. Không chặn, không đổi phản hồi.
 */
export function inputAuditTrail(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction): void {
  try {
    observe(req, res);
  } catch {
    // quan sát là phụ — không làm hỏng request
  }
  next();
}

type ErrorHandler = (err: unknown, req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => void;

/**
 * Bọc handler lỗi toàn cục: phân loại lỗi đầu vào rồi giao nguyên cho handler gốc (phản hồi không đổi). Request chưa qua
 * `inputAuditTrail` (lỗi body-parser — chạy trước middleware của dự án) → gắn quan sát ngay tại đây.
 */
export function withInputAudit(handler: ErrorHandler): ErrorHandler {
  return (err, req, res, next) => {
    try {
      const rejection = classifyInputError(err);
      if (rejection !== null) {
        stateOf(req).classified = rejection;
        observe(req, res);
      }
    } catch {
      // phân loại là phụ — không làm hỏng xử lý lỗi
    }
    return handler(err, req, res, next);
  };
}
