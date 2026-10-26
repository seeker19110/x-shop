import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { can, type Permission, type Role } from "@x-shop/domain";
import { RBAC_MODULE } from "../../modules/rbac";
import type RbacModuleService from "../../modules/rbac/service";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { decideDenyAudit, type WindowCounter } from "../audit/deny-throttle";
import { recordAudit } from "../audit/record";
import { sendProblem } from "../http/problem";
import { clientIpOf } from "../security/config";
import { getAdminSessionPolicy, isSensitive } from "./config";
import { resolveAdminRule, type AdminRule } from "./policy";
import { registerAttempt, registerRefund, registerSuccess, type LimitScope } from "./rate-limit";
import { normalizeAdminPath, normalizeMethod } from "./route-match";
import { checkAndTouchSession, evaluateMfa, mfaCompletedAtMs, type AdminAuthContext } from "./session";

type AuthedRequest = MedusaRequest & { auth_context?: AdminAuthContext };

const storeOf = (req: MedusaRequest) => req.scope.resolve<RbacModuleService>(RBAC_MODULE).securityStore();

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

/**
 * Cổng bảo mật cho MỌI request `/admin/*` (T-023 + T-024), chạy sau middleware xác thực native của Medusa:
 *  1. route công khai native (invite accept, feature flags) → cho qua;
 *  2. chỉ actor `user` (khoá API bí mật không có vai trò → từ chối);
 *  3. chính sách phiên: hết hạn tuyệt đối / nhàn rỗi → 401;
 *  4. quyền theo map (`/admin/x/*`: permissions.ts, fail-closed; native: native-permissions.ts) × vai trò → 403 + audit;
 *  5. quyền nhạy cảm → MFA đã xác minh (403 MFA_REQUIRED); thao tác `reauth` → MFA ≤ 5 phút (403 REAUTH_REQUIRED).
 */
export async function adminSecurityGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const method = normalizeMethod(req.method);
  if (method === "OPTIONS") return next();
  const path = normalizeAdminPath(req.originalUrl);
  const rule = resolveAdminRule(method, path);
  if (rule.kind === "public") return next();

  const ctx = (req as AuthedRequest).auth_context;
  if (!ctx?.actor_id) return deny(res, 401, "UNAUTHORIZED");
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
      return deny(res, 403, mfa.code, {
        permission: rule.permission,
        ...(mfa.code === "REAUTH_REQUIRED" && { max_age_seconds: policy.reauthMaxAgeSeconds }),
      });
    }
  }

  (req as MedusaRequest & { x_admin_access?: AdminAccess }).x_admin_access = {
    userId: ctx.actor_id,
    roles,
    permission: rule.kind === "permission" ? rule.permission : null,
  };
  return next();
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
  deny(res, 403, mfa.code, { max_age_seconds: policy.reauthMaxAgeSeconds });
  return true;
}

/**
 * `POST /auth/token/refresh` cho admin: token đổi mới giữ mốc MFA nên không kéo dài phiên quá hạn tuyệt đối; token
 * admin KHÔNG có MFA thì không refresh được (mốc của nó là `iat`, refresh sẽ đặt lại mốc → lách hạn 8 giờ).
 */
export async function adminRefreshGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const ctx = (req as AuthedRequest).auth_context;
  if (!ctx || ctx.actor_type !== "user" || !ctx.actor_id) return next();
  if (mfaCompletedAtMs(ctx) === null) return deny(res, 401, "SESSION_EXPIRED", { action: "login" });
  const session = await checkAndTouchSession(storeOf(req), ctx, getAdminSessionPolicy());
  if (!session.ok) return deny(res, 401, session.code);
  return next();
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
    if (!attempt.allowed) {
      res.setHeader("Retry-After", String(attempt.retryAfterSeconds));
      return deny(res, 429, "RATE_LIMITED", { retry_after: attempt.retryAfterSeconds });
    }
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

export const loginIdentity = (req: MedusaRequest): string | null => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.slice(0, 320) : null;
};

export const mfaIdentity = (req: MedusaRequest): string | null =>
  (req as AuthedRequest).auth_context?.auth_identity_id || null;
