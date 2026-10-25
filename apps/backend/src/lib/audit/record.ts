import { createHmac } from "node:crypto";
import type { MedusaRequest } from "@medusajs/framework/http";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import type { AuditEntry, AuditEntryInput } from "../../modules/audit/service";

type Scope = Pick<MedusaContainer, "resolve">;

/** Băm IP bằng HMAC-SHA256 với bí mật phía server (cookieSecret) — không lưu IP thô, không dò ngược được bằng vét 2^32. */
export function hashIp(scope: Scope, ip: string | undefined | null): string | null {
  if (!ip) return null;
  const config = scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE);
  const key = String(
    config.projectConfig.http.cookieSecret ?? config.projectConfig.http.jwtSecret ?? "x-shop",
  );
  return createHmac("sha256", key).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Ngữ cảnh actor/request từ HTTP request (dùng ở route admin). */
export function auditContextOf(
  req: MedusaRequest,
): Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash"> {
  const ctx = (req as MedusaRequest & { auth_context?: { actor_id?: string; actor_type?: string } })
    .auth_context;
  const header = req.headers["x-request-id"];
  const rid =
    (req as MedusaRequest & { requestId?: string }).requestId ?? (typeof header === "string" ? header : null);
  return {
    actor_type: ctx?.actor_type || "anonymous",
    actor_id: ctx?.actor_id || null,
    request_id: rid && REQUEST_ID.test(rid) ? rid : null,
    ip_hash: hashIp(req.scope, req.ip),
  };
}

/**
 * `audit.record()` — ghi một dòng audit (che PII trong `changes` ở service). Dùng ở: RBAC từ chối, đổi vai trò, điều
 * chỉnh tồn, import (T-016/T-025). Có `req` → tự lấy actor, request id, IP băm.
 */
export async function recordAudit(
  scope: Scope,
  entry: Omit<AuditEntryInput, "actor_type" | "actor_id"> & Partial<AuditEntryInput>,
  req?: MedusaRequest,
): Promise<AuditEntry> {
  const audit = scope.resolve<AuditModuleService>(AUDIT_MODULE);
  const fromReq = req
    ? auditContextOf(req)
    : { actor_type: "system", actor_id: null, request_id: null, ip_hash: null };
  return audit.record({ ...fromReq, ...entry } as AuditEntryInput);
}
