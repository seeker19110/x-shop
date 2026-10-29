import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { can, type Permission, type Role, isNonEmpty } from "@x-shop/domain";
import { RBAC_MODULE } from "../../modules/rbac";
import type RbacModuleService from "../../modules/rbac/service";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { decideDenyAudit, type WindowCounter } from "../audit/deny-throttle";
import { recordAudit } from "../audit/record";
import { sendProblem } from "../http/problem";
import { decodePathSegments, INVALID_PATH, rawRequestPath } from "../http/request-path";
import { clientIpOf } from "../security/config";
import { getAdminSessionPolicy, isSensitive } from "./config";
import { forbiddenFields, nativeFieldPolicy, requestedFields } from "./field-policy";
import { isAdminPath, isAdminXPath, resolveAdminRule, strictestRule, type AdminRule } from "./policy";
import { registerAttempt, registerRefund, registerSuccess, type LimitScope } from "./rate-limit";
import { normalizeAdminPath, normalizeMethod } from "./route-match";
import { checkAndTouchSession, evaluateMfa, mfaCompletedAtMs, type AdminAuthContext } from "./session";
import { AuthRouteParams, readParams, readQueryBag } from "../http/request-input";

type AuthedRequest = MedusaRequest & { auth_context?: AdminAuthContext };

export const storeOf = (req: MedusaRequest) =>
  req.scope.resolve<RbacModuleService>(RBAC_MODULE).securityStore();

/** Thông tin RBAC đã kiểm, gắn vào request cho route dùng tiếp (vd. che PII theo vai trò). */
export interface AdminAccess {
  userId: string;
  roles: Role[];
  permission: Permission | null;
}

export const adminAccessOf = (req: MedusaRequest): AdminAccess | undefined =>
  (req as MedusaRequest & { x_admin_access?: AdminAccess }).x_admin_access;

const MESSAGES = {
  UNAUTHORIZED: "Chưa đăng nhập",
  SESSION_EXPIRED: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
  SESSION_IDLE: "Phiên đã nhàn rỗi quá lâu, vui lòng đăng nhập lại",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này",
  MFA_REQUIRED: "Thao tác này cần xác thực hai lớp (TOTP) đã bật và đã xác minh trong phiên",
  REAUTH_REQUIRED: "Thao tác nhạy cảm cần xác thực lại (đăng nhập + mã TOTP) trong vài phút gần đây",
  RATE_LIMITED: "Thử quá nhiều lần, vui lòng thử lại sau",
} as const;

function deny(
  res: MedusaResponse,
  status: number,
  code: keyof typeof MESSAGES,
  extra: Record<string, unknown> = {},
) {
  sendProblem(res, status, code, MESSAGES[code], [], extra);
}

/** Lớp route để gộp audit từ chối (không dùng đường dẫn cụ thể — đổi id không lách được giới hạn). */
export function routeClassOf(rule: AdminRule): string {
  switch (rule.kind) {
    case "permission":
      return `perm:${[rule.permission, ...rule.also].join("+")}`;
    case "deny":
      return `deny:${rule.reason}`;
    default:
      return rule.kind;
  }
}

/**
 * Bộ đếm cửa sổ cố định ở Postgres (bảng `rate_limit_counter`, nguyên tử, chung mọi instance, có job dọn). Gộp audit cần
 * số lần THÔ trong cửa sổ (ghi lần 1, 10, 100…) — không phải quyết định chặn, nên không dùng số hiệu dụng cửa sổ trượt.
 */
const denyCounter =
  (req: MedusaRequest): WindowCounter =>
  async (bucket, windowMs, now) =>
    (await req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE).hitRateCounter(bucket, windowMs, now))
      .current;

async function auditDenied(
  req: MedusaRequest,
  method: string,
  path: string,
  rule: AdminRule,
  detail: Record<string, unknown> & { reason: string },
) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const ctx = (req as AuthedRequest).auth_context;
  try {
    // Chống ngập log: gộp theo (actor, lớp route, lý do) trong cửa sổ — chỉ ghi lần 1, 10, 100… (deny-throttle.ts).
    const decision = await decideDenyAudit(
      denyCounter(req),
      {
        actorType: ctx?.actor_type ?? "unknown",
        actorId: ctx?.actor_id ?? null,
        method,
        routeClass: routeClassOf(rule),
        reason: detail.reason,
      },
      new Date(),
      (e) => logger.warn(`[rbac] Bộ đếm audit từ chối lỗi, vẫn ghi audit: ${(e as Error).message}`),
    );
    if (!decision.record) return;
    await recordAudit(
      req.scope,
      {
        action: "rbac.denied",
        resource_type: "route",
        resource_id: `${method} ${path}`,
        changes: {
          ...detail,
          throttle: { occurrence: decision.occurrence, window_seconds: decision.window_seconds },
        },
      },
      req,
    );
  } catch (e) {
    logger.error(`[rbac] Không ghi được audit lần từ chối: ${(e as Error).message}`);
  }
}

/** Quy tắc/nhãn audit cho path admin không hợp lệ (400 INVALID_PATH, D-080) — lớp route `deny:INVALID_PATH`. */
const INVALID_PATH_RULE: AdminRule = { kind: "deny", reason: "INVALID_PATH" };
export const INVALID_PATH_RESOURCE = "(đường dẫn không hợp lệ)";

/**
 * Quy tắc quyền cho request admin (T-145) — tra từ pathname ROUTER THẤY (`lib/http/request-path.ts`), không từ
 * `originalUrl` thô (URL tuyệt đối, `\`+`#` từng rơi xuống mặc định `any_role` trong khi Express vẫn tới route nhạy cảm):
 *  - `path`: đã giải mã `%xx` từng đoạn + chuẩn hoá như Express (hoa/thường, `//`, `/` cuối) — dùng cho quy tắc và audit;
 *  - path chưa giải mã (đúng chuỗi Express khớp route) khác `path` → áp quy tắc CHẶT HƠN của hai (`strictestRule`).
 * `null` = không hợp lệ (mã hoá hỏng, không parse được, hoặc không nằm dưới `/admin` dù cổng gắn ở `/admin` — lệch parse)
 * → nơi gọi trả 400, đóng an toàn.
 */
export function adminRuleOf(
  req: { originalUrl?: unknown; url?: unknown },
  method: string,
): { path: string; rule: AdminRule } | null {
  const raw = rawRequestPath(req);
  const decoded = raw === null ? null : decodePathSegments(raw);
  if (raw === null || decoded === null) return null;
  const path = normalizeAdminPath(decoded);
  const routed = normalizeAdminPath(raw);
  if (!isAdminPath(path) || !isAdminPath(routed)) return null;
  const rule = resolveAdminRule(method, path);
  return { path, rule: routed === path ? rule : strictestRule(rule, resolveAdminRule(method, routed)) };
}

/**
 * Cổng bảo mật cho MỌI request `/admin/*` (T-023 + T-024), chạy sau middleware xác thực native của Medusa:
 *  1. route công khai native (invite accept, feature flags) → cho qua;
 *  2. chỉ actor `user` (khoá API bí mật không có vai trò → từ chối);
 *  3. chính sách phiên: hết hạn tuyệt đối / nhàn rỗi → 401;
 *  4. quyền theo map (`/admin/x/*`: permissions.ts, fail-closed; native: native-permissions.ts) × vai trò → 403 + audit;
 *  5. quyền nhạy cảm → MFA đã xác minh (403 MFA_REQUIRED); thao tác `reauth` → MFA ≤ 5 phút (403 REAUTH_REQUIRED).
 * Mọi 403 (bước 2, 4, 5, chính sách trường) và 400 đường dẫn hỏng đều ghi `rbac.denied` (gộp tần suất).
 */
export async function adminSecurityGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const method = normalizeMethod(req.method);
  if (method === "OPTIONS") return next();
  const resolved = adminRuleOf(req, method);
  if (resolved === null) {
    // D-080: ghi audit qua cùng bộ gộp từ chối (lần 1, 10, 100… theo actor + lớp route). Không ghi đường dẫn thô —
    // có thể chứa PII/rác đối nghịch; chỉ method + nhãn cố định.
    await auditDenied(req, method, INVALID_PATH_RESOURCE, INVALID_PATH_RULE, { reason: "invalid_path" });
    return sendProblem(res, INVALID_PATH.status, INVALID_PATH.code, INVALID_PATH.title);
  }
  const { path, rule } = resolved;
  if (rule.kind === "public") return next();

  const ctx = (req as AuthedRequest).auth_context;
  if (!ctx || !isNonEmpty(ctx.actor_id)) return deny(res, 401, "UNAUTHORIZED");
  if (ctx.actor_type !== "user") {
    await auditDenied(req, method, path, rule, { reason: "actor_type", actor_type: ctx.actor_type ?? null });
    return deny(res, 403, "FORBIDDEN");
  }

  const policy = getAdminSessionPolicy();
  const session = await checkAndTouchSession(storeOf(req), ctx, policy);
  if (!session.ok) return deny(res, 401, session.code);

  const rbac = req.scope.resolve<RbacModuleService>(RBAC_MODULE);
  const roles = rule.kind === "self" ? [] : await rbac.rolesOf(ctx.actor_id);
  const allowed =
    rule.kind === "self" ||
    (rule.kind === "any_role" && roles.length > 0) ||
    (rule.kind === "permission" && [rule.permission, ...rule.also].every((perm) => can(roles, perm)));
  if (!allowed) {
    await auditDenied(req, method, path, rule, {
      reason: rule.kind === "deny" ? rule.reason : "missing_permission",
      permission: rule.kind === "permission" ? rule.permission : null,
      ...(rule.kind === "permission" && rule.also.length > 0 && { also: rule.also }),
      roles,
    });
    return deny(res, 403, "FORBIDDEN", rule.kind === "permission" ? { permission: rule.permission } : {});
  }

  if (rule.kind === "permission" && ([rule.permission, ...rule.also].some(isSensitive) || rule.reauth)) {
    const mfa = evaluateMfa(ctx, Date.now(), rule.reauth ? policy.reauthMaxAgeSeconds : null);
    if (!mfa.ok) {
      // T-175: 403 thiếu MFA/xác thực lại cũng là lần từ chối quyền → `rbac.denied`, lý do = mã phản hồi (cùng bộ gộp).
      await auditDenied(req, method, path, rule, { reason: mfa.code, permission: rule.permission });
      return deny(res, 403, mfa.code, {
        permission: rule.permission,
        ...(mfa.code === "REAUTH_REQUIRED" && { max_age_seconds: policy.reauthMaxAgeSeconds }),
      });
    }
  }

  // Mọi method (T-147 review 2): handler GHI của Medusa cũng tải lại thực thể theo `req.queryConfig.fields`.
  if (!isAdminXPath(path)) {
    const blocked = applyNativeFieldPolicy(req, path, roles);
    if (blocked !== null) {
      await auditDenied(req, method, path, rule, { reason: "forbidden_fields", fields: blocked, roles });
      return deny(res, 403, "FORBIDDEN", { fields: blocked });
    }
  }

  (req as MedusaRequest & { x_admin_access?: AdminAccess }).x_admin_access = {
    userId: ctx.actor_id,
    roles,
    permission: rule.kind === "permission" ? rule.permission : null,
  };
  return next();
}

/** Thuộc tính request mà `validateAndTransformQuery` của Medusa 2.22.1 đọc (`req.disallowed ?? queryConfig.disallowed`). */
type FieldFilteredRequest = MedusaRequest & { disallowed?: (string | RegExp)[]; allowed?: string[] };

/**
 * Chính sách trường cho route native, mọi method (field-policy.ts, T-147 review): trường yêu cầu qua `fields`/`order` vi phạm →
 * trả danh sách (nơi gọi 403 + audit); không vi phạm → gán `req.disallowed`/`req.allowed` để Medusa gỡ trường cấm khỏi
 * trường MẶC ĐỊNH của route. Không route admin native nào của Medusa 2.22.1 tự đặt `disallowed` (rbac.spec.ts kiểm) nên
 * gán đè không xoá giới hạn sẵn có.
 */
export function applyNativeFieldPolicy(
  req: MedusaRequest,
  path: string,
  roles: readonly Role[],
): string[] | null {
  const policy = nativeFieldPolicy(path, roles);
  if (policy === null) return null;
  const query = readQueryBag(req);
  const requested = requestedFields(query.ok ? query.data : undefined);
  const bad = requested === null ? ["(fields/order không hợp lệ)"] : forbiddenFields(requested, policy);
  if (bad.length > 0) return [...new Set(bad)].slice(0, 10).map((f) => f.slice(0, 120));
  const r = req as FieldFilteredRequest;
  if (policy.disallowed.length > 0) r.disallowed = [...policy.disallowed];
  if (policy.allowed !== null) r.allowed = [...policy.allowed];
  return null;
}

/**
 * Xác thực lại cho thao tác nhạy cảm quyết định TRONG route (vd. hoàn tiền vượt ngưỡng — T-027 gọi khi biết số tiền).
 * Trả `true` khi đã gửi 403 REAUTH_REQUIRED/MFA_REQUIRED.
 */
export function rejectWithoutRecentMfa(req: MedusaRequest, res: MedusaResponse): boolean {
  const ctx = (req as AuthedRequest).auth_context ?? {};
  const policy = getAdminSessionPolicy();
  const mfa = evaluateMfa(ctx, Date.now(), policy.reauthMaxAgeSeconds);
  if (mfa.ok) return false;
  // T-175: audit như cổng (`rbac.denied`, lý do = mã) — chạy nền, không đổi phản hồi; lỗi ghi audit chỉ vào log.
  const method = normalizeMethod(req.method);
  const resolved = adminRuleOf(req, method);
  auditDenied(req, method, resolved?.path ?? INVALID_PATH_RESOURCE, resolved?.rule ?? INVALID_PATH_RULE, {
    reason: mfa.code,
    in_route: true,
  }).catch(() => undefined);
  deny(res, 403, mfa.code, { max_age_seconds: policy.reauthMaxAgeSeconds });
  return true;
}

/**
 * `POST /auth/token/refresh` cho admin: token đổi mới giữ mốc MFA nên không kéo dài phiên quá hạn tuyệt đối; token
 * admin KHÔNG có MFA thì không refresh được (mốc của nó là `iat`, refresh sẽ đặt lại mốc → lách hạn 8 giờ).
 */
export async function adminRefreshGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const ctx = (req as AuthedRequest).auth_context;
  if (!ctx || ctx.actor_type !== "user" || !isNonEmpty(ctx.actor_id)) return next();
  if (mfaCompletedAtMs(ctx) === null) return deny(res, 401, "SESSION_EXPIRED", { action: "login" });
  const session = await checkAndTouchSession(storeOf(req), ctx, getAdminSessionPolicy());
  if (!session.ok) return deny(res, 401, session.code);
  return next();
}

/** 429 RATE_LIMITED + `Retry-After` — chung cho mọi rate limit /auth (đăng nhập, đăng ký, MFA, đặt lại mật khẩu). */
export function sendRateLimited(res: MedusaResponse, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  deny(res, 429, "RATE_LIMITED", { retry_after: retryAfterSeconds });
}

/**
 * Rate limit đăng nhập / xác minh MFA theo nhiều tín hiệu (SEC03). Lần thử được giữ chỗ trước khi handler chạy; kết
 * quả 2xx → hoàn lại (không tính thất bại), 4xx → giữ là thất bại, 5xx → hoàn lại (lỗi hệ thống không phạt người dùng).
 */
export function authRateLimit(scope: LimitScope, identityOf: (req: MedusaRequest) => string | null) {
  return async (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
    const store = storeOf(req);
    const identity = identityOf(req);
    const ip = clientIpOf(req).ip ?? "unknown";
    // Một mốc cho cả lần thử: hoàn lại (thành công/5xx) vào đúng cửa sổ đã giữ chỗ dù phản hồi xong sau ranh giới.
    const at = new Date();
    const attempt = await registerAttempt(store, scope, identity, ip, at);
    if (!attempt.allowed) return sendRateLimited(res, attempt.retryAfterSeconds);
    // Ghi sổ thành công/hoàn lại TRƯỚC khi phản hồi rời máy chủ: làm ở sự kiện `finish` (bất đồng bộ, sau khi khách đã
    // nhận phản hồi) thì một lần thành công có thể xoá bộ đếm SAU KHI các lần thử kế tiếp của cùng định danh đã được
    // đếm — mất đếm thất bại (race tái hiện ở test mfa khi máy tải nặng).
    const originalEnd = res.end.bind(res) as (...a: unknown[]) => MedusaResponse;
    let settled = false;
    (res as unknown as { end: (...a: unknown[]) => MedusaResponse }).end = (...args: unknown[]) => {
      if (settled) return originalEnd(...args);
      settled = true;
      const s = res.statusCode;
      const book =
        s < 400
          ? registerSuccess(store, scope, identity, ip, at)
          : s >= 500
            ? registerRefund(store, scope, identity, ip, at)
            : Promise.resolve();
      book.catch(() => undefined).finally(() => originalEnd(...args));
      return res;
    };
    return next();
  };
}

function isEmailpassRoute(req: MedusaRequest): boolean {
  const params = readParams(req, AuthRouteParams.pick({ auth_provider: true }));
  return params.ok && params.data.auth_provider === "emailpass";
}

/**
 * Chỉ chạy `mw` khi tham số `auth_provider` (Express đã giải mã `%xx`) đúng là `emailpass` — provider mật khẩu duy nhất.
 * Dùng cho matcher tham số `/auth/:actor_type/:auth_provider`: matcher này cũng khớp route tĩnh `/auth/token/refresh`,
 * `/auth/mfa/factors`… (không phải đăng nhập); provider khác `emailpass` (kể cả `EMAILPASS`) Auth Module không phân giải
 * được nên không là kênh đoán mật khẩu.
 */
export function emailpassOnly(
  mw: (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => Promise<void> | void,
) {
  return (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) =>
    isEmailpassRoute(req) ? mw(req, res, next) : next();
}

/**
 * `GET`/`HEAD /auth/:actor_type/emailpass` → 405 (T-138). Route gốc Medusa export cả `GET` = authenticate (dành cho bước
 * chuyển hướng OAuth); body-parser vẫn đọc thân của GET và CSRF bỏ qua GET ⇒ đoán mật khẩu bằng GET lách rate limit đăng
 * nhập (chỉ khai POST) và nhận JWT thật. Dashboard/SDK đăng nhập emailpass bằng POST; provider khác (OAuth) không bị chạm.
 */
export function rejectEmailpassGet(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  if (!isEmailpassRoute(req)) return next();
  res.setHeader("Allow", "POST");
  return sendProblem(res, 405, "METHOD_NOT_ALLOWED", "Đăng nhập email/mật khẩu chỉ nhận POST");
}

/**
 * Định danh rate limit đăng nhập/đăng ký = email (identity emailpass dùng chung mọi actor: `entity_id = email`) — thất bại
 * qua `/auth/customer/emailpass`, `/auth/<actor lạ>/emailpass` cộng chung bộ đếm với `/auth/user/emailpass`.
 */
export const loginIdentity = (req: MedusaRequest): string | null => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.slice(0, 320) : null;
};

export const mfaIdentity = (req: MedusaRequest): string | null => {
  const id = (req as AuthedRequest).auth_context?.auth_identity_id;
  return isNonEmpty(id) ? id : null;
};
