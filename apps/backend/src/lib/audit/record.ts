import { createHmac } from "node:crypto";
import type { MedusaRequest } from "@medusajs/framework/http";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import { clientIpOf } from "../security/config";
import { REQUEST_ID_PATTERN, traceIdOf } from "../errors/trace";
import { isAppLogger } from "../log/logger";
import { sanitizeUserAgent } from "./sanitize";
import type { AuditEntry, AuditEntryInput } from "../../modules/audit/service";
import { isNonEmpty } from "@x-shop/domain";

type Scope = Pick<MedusaContainer, "resolve">;

function pseudonymKey(scope: Scope): string {
  const config = scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE);
  return String(config.projectConfig.http.cookieSecret ?? config.projectConfig.http.jwtSecret ?? "x-shop");
}

/** Băm IP bằng HMAC-SHA256 với bí mật phía server (cookieSecret) — không lưu IP thô, không dò ngược được bằng vét 2^32. */
export function hashIp(scope: Scope, ip: string | undefined | null): string | null {
  if (!isNonEmpty(ip)) return null;
  return createHmac("sha256", pseudonymKey(scope)).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

/**
 * Bí danh của định danh đăng nhập (email) cho audit — HMAC-SHA256 (khoá phía server) của email đã trim + chữ thường,
 * tiền tố `idh_`. Cùng email → cùng bí danh (gom được mọi lần thử vào một tài khoản, kể cả email không tồn tại) mà không
 * lưu email thô; không có khoá thì không dò ngược bằng từ điển email.
 */
export function hashIdentifier(scope: Scope, identifier: string | undefined | null): string | null {
  const v = identifier?.trim().toLowerCase();
  if (!isNonEmpty(v)) return null;
  return `idh_${createHmac("sha256", pseudonymKey(scope)).update(`id:${v}`).digest("hex").slice(0, 32)}`;
}

export type AuditRequestContext = Pick<
  AuditEntryInput,
  "actor_type" | "actor_id" | "request_id" | "ip_hash" | "user_agent"
>;

/**
 * Ngữ cảnh actor/request từ HTTP request (dùng ở route admin): actor (auth_context), `request_id` = `trace_id` của
 * request (cùng mã trong log JSON và problem+json — `traceIdOf`), IP băm, User-Agent (service cắt ngắn + che).
 */
export function auditContextOf(req: MedusaRequest): AuditRequestContext {
  const ctx = (req as MedusaRequest & { auth_context?: { actor_id?: string; actor_type?: string } })
    .auth_context;
  const rid = traceIdOf(req);
  // actor rỗng ("") coi như không có actor — giữ hành vi cũ.
  const actorType = ctx?.actor_type;
  const actorId = ctx?.actor_id;
  return {
    actor_type: isNonEmpty(actorType) ? actorType : "anonymous",
    actor_id: isNonEmpty(actorId) ? actorId : null,
    request_id: REQUEST_ID_PATTERN.test(rid) ? rid : null,
    ip_hash: hashIp(req.scope, clientIpOf(req).ip),
    user_agent: sanitizeUserAgent(req.headers["user-agent"]),
  };
}

/**
 * `audit.record()` — ghi một dòng audit (che PII trong `changes` ở service). Dùng ở: RBAC từ chối, đổi vai trò, điều
 * chỉnh tồn, import (T-016/T-025), sự kiện xác thực/xuất dữ liệu (T-091, lib/audit/http.ts). Có `req` → tự lấy actor,
 * request id (= trace_id), IP băm, User-Agent. `outcome` mặc định theo hành động (defaultOutcomeOf) — truyền tường minh
 * khi thất bại/bị từ chối. Danh mục sự kiện: docs/security/security-events.md.
 */
export async function recordAudit(
  scope: Scope,
  entry: Omit<AuditEntryInput, "actor_type" | "actor_id"> & Partial<AuditEntryInput>,
  req?: MedusaRequest,
): Promise<AuditEntry> {
  const audit = scope.resolve<AuditModuleService>(AUDIT_MODULE);
  const fromReq = req
    ? auditContextOf(req)
    : { actor_type: "system", actor_id: null, request_id: null, ip_hash: null, user_agent: null };
  const saved = await audit.record({ ...fromReq, ...entry } as AuditEntryInput);
  emitSecurityLog(scope, saved);
  return saved;
}

/**
 * Một dòng log JSON `security.audit` cho mỗi dòng audit đã ghi qua `recordAudit` (SEC-LOG-001: sự kiện bảo mật có bản
 * ghi có cấu trúc trong luồng log để Collector chuyển về kho tập trung — SEC-LOG-006). Chỉ trường định danh/kết quả đã
 * che — không `changes`/`reason`/User-Agent. Logger lấy từ container của request/ứng dụng (logger JSON của dự án; module
 * Medusa nhận logger mặc định nên không log ở service). Lỗi log không làm hỏng việc ghi audit.
 */
export function emitSecurityLog(scope: Scope, saved: AuditEntry): void {
  try {
    const logger: unknown = scope.resolve(ContainerRegistrationKeys.LOGGER);
    if (!isAppLogger(logger)) return;
    logger.emit(saved.outcome === "success" ? "info" : "warn", "security.audit", {
      "event.name": saved.action,
      "event.outcome": saved.outcome,
      audit_id: saved.id,
      actor_type: saved.actor_type,
      actor_id: saved.actor_id,
      target_type: saved.resource_type,
      target_id: saved.resource_id,
      ip_hash: saved.ip_hash,
      request_id: saved.request_id,
    });
  } catch {
    // bỏ qua: dòng audit trong DB là nguồn chính
  }
}
