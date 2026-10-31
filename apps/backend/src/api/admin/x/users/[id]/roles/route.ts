import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { ROLES } from "@x-shop/domain";
import { z } from "zod";
import { SECURITY_EVENTS } from "../../../../../../lib/audit/events";
import { auditContextOf, recordAudit } from "../../../../../../lib/audit/record";
import { sendProblem, zodErrors } from "../../../../../../lib/http/problem";
import {
  IdParams,
  readParams,
  readQuery,
  sendInvalidInput,
  sendParamNotFound,
} from "../../../../../../lib/http/request-input";
import { RBAC_MODULE } from "../../../../../../modules/rbac";
import type RbacModuleService from "../../../../../../modules/rbac/service";

/**
 * Quản lý vai trò admin (T-023). Quyền `user.manage` + MFA xác thực lại ≤ 5 phút (map permissions.ts, guard). Mọi thay
 * đổi ghi audit (actor, trước/sau, lý do, kết quả) — cả lần không thành công (user không có, owner cuối cùng — T-091).
 */
const RoleBody = z.object({
  role: z.enum(ROLES, { message: `phải là một trong ${ROLES.join("|")}` }),
  reason: z.string().trim().max(500).optional(),
});

/** `resource_id` audit khi `:id` sai dạng (rỗng/quá dài/không phải chuỗi) — không ghi id thô của đầu vào hỏng. */
const INVALID_ID_MARK = "(invalid-id)";

async function userExists(req: MedusaRequest, id: string): Promise<boolean> {
  const users = await req.scope.resolve(Modules.USER).listUsers({ id: [id] }, { select: ["id"] });
  return users.length > 0;
}

/** Đổi quyền KHÔNG thành công cũng ghi audit (T-091, CMP-AUDIT-002 `result`): user không có, owner cuối cùng. */
async function auditRoleFailure(
  req: MedusaRequest,
  action: string,
  id: string,
  role: string,
  reason: string | null,
  errorCode: string,
) {
  await recordAudit(
    req.scope,
    {
      action,
      resource_type: "user",
      resource_id: id,
      reason,
      outcome: "failure",
      changes: { role, error_code: errorCode },
    },
    req,
  );
}

/** GET /admin/x/users/:id/roles */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const params = readParams(req, IdParams);
  if (!params.ok) return sendParamNotFound(res);
  const id = params.data.id;
  if (!(await userExists(req, id))) return sendProblem(res, 404, "NOT_FOUND", "Không thấy người dùng");
  const rbac = req.scope.resolve<RbacModuleService>(RBAC_MODULE);
  res.setHeader("Cache-Control", "no-store");
  res.json({ user_id: id, roles: await rbac.listAssignments(id) });
};

/** POST /admin/x/users/:id/roles {role, reason?} — cấp vai trò (idempotent: đã có → 200). */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = RoleBody.safeParse(req.body ?? {});
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const params = readParams(req, IdParams);
  if (!params.ok) {
    // Id sai dạng cũng là thao tác không thành công trên user không có → vẫn ghi audit (T-091); id thô không dùng được.
    await auditRoleFailure(
      req,
      SECURITY_EVENTS.ROLE_GRANTED,
      INVALID_ID_MARK,
      parsed.data.role,
      parsed.data.reason ?? null,
      "NOT_FOUND",
    );
    return sendParamNotFound(res);
  }
  const id = params.data.id;
  if (!(await userExists(req, id))) {
    await auditRoleFailure(
      req,
      SECURITY_EVENTS.ROLE_GRANTED,
      id,
      parsed.data.role,
      parsed.data.reason ?? null,
      "NOT_FOUND",
    );
    return sendProblem(res, 404, "NOT_FOUND", "Không thấy người dùng");
  }
  const rbac = req.scope.resolve<RbacModuleService>(RBAC_MODULE);
  const ctx = auditContextOf(req);
  const before = await rbac.rolesOf(id);
  const { created } = await rbac.grant(id, parsed.data.role, ctx.actor_id);
  if (created) {
    await recordAudit(req.scope, {
      ...ctx,
      action: SECURITY_EVENTS.ROLE_GRANTED,
      outcome: "success",
      resource_type: "user",
      resource_id: id,
      reason: parsed.data.reason ?? null,
      changes: { role: parsed.data.role, before, after: await rbac.rolesOf(id) },
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(created ? 201 : 200).json({ user_id: id, roles: await rbac.rolesOf(id), changed: created });
};

/** DELETE /admin/x/users/:id/roles {role} (hoặc ?role=) — thu hồi; không thu hồi owner cuối cùng (409 LAST_OWNER). */
export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = readQuery(req, z.object({ role: z.unknown().optional(), reason: z.unknown().optional() }));
  if (!query.ok) return sendInvalidInput(res, query.errors);
  const parsed = RoleBody.safeParse({
    role: body.role ?? query.data.role,
    reason: body.reason ?? query.data.reason,
  });
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const params = readParams(req, IdParams);
  if (!params.ok) return sendParamNotFound(res);
  const id = params.data.id;
  const rbac = req.scope.resolve<RbacModuleService>(RBAC_MODULE);
  const ctx = auditContextOf(req);
  const before = await rbac.rolesOf(id);
  const { removed, lastOwner } = await rbac.revoke(id, parsed.data.role);
  if (lastOwner) {
    await auditRoleFailure(
      req,
      SECURITY_EVENTS.ROLE_REVOKED,
      id,
      parsed.data.role,
      parsed.data.reason ?? null,
      "LAST_OWNER",
    );
    return sendProblem(res, 409, "LAST_OWNER", "Không thể thu hồi owner cuối cùng");
  }
  if (removed) {
    await recordAudit(req.scope, {
      ...ctx,
      action: SECURITY_EVENTS.ROLE_REVOKED,
      outcome: "success",
      resource_type: "user",
      resource_id: id,
      reason: parsed.data.reason ?? null,
      changes: { role: parsed.data.role, before, after: await rbac.rolesOf(id) },
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ user_id: id, roles: await rbac.rolesOf(id), changed: removed });
};
