import { z } from "zod";
import { AUDIT_OUTCOMES } from "../../modules/audit/service";
import { USER_AGENT_MAX } from "./sanitize";

/**
 * Schema của MỘT bản ghi sự kiện bảo mật/audit ở dạng JSON (GET /admin/x/audit, SEC-LOG-002) — trường tối thiểu theo
 * OWASP Logging Cheat Sheet: thời điểm UTC (`created_at`, ISO-8601 `…Z`), sự kiện (`action`), ai (`actor_type`/`actor_id`
 * — id hệ thống hoặc bí danh, không tên/email), đích (`resource_type`/`resource_id`), kết quả (`outcome`), nguồn
 * (`ip_hash`, `user_agent`), tương quan (`request_id` = `trace_id`).
 *
 * Bản JSON Schema sinh từ đây nằm ở `docs/security/security-event.schema.json`; test `security-events.unit.spec.ts` đối
 * chiếu hai bên (sửa schema → sinh lại: `UPDATE_SECURITY_SCHEMA=1 pnpm --filter @x-shop/backend test -- security-events`).
 */
const nullableId = z.string().min(1).max(256).nullable();

export const SecurityAuditRecord = z
  .object({
    id: z.string().regex(/^audit_[0-9A-Z]+$/),
    created_at: z.iso.datetime({ offset: false }),
    action: z
      .string()
      .max(128)
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
    actor_type: z.string().min(1).max(32),
    actor_id: z.string().min(1).max(128).nullable(),
    resource_type: z.string().min(1).max(64),
    resource_id: nullableId,
    outcome: z.enum(AUDIT_OUTCOMES),
    ip_hash: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    user_agent: z.string().min(1).max(USER_AGENT_MAX).nullable(),
    request_id: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .nullable(),
    reason: z.string().max(1000).nullable(),
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();

export type SecurityAuditRecord = z.infer<typeof SecurityAuditRecord>;

/** JSON Schema (draft 2020-12) của bản ghi — nguồn của `docs/security/security-event.schema.json`. */
export function securityEventJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://x-shop.local/schemas/security-event.schema.json",
    title: "x-shop security/audit event",
    ...z.toJSONSchema(SecurityAuditRecord, { target: "draft-2020-12" }),
  };
}
