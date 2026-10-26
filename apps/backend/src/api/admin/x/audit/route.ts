import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { adminPageQuery } from "../../../../lib/http/pagination";
import { sendProblem, zodErrors } from "../../../../lib/http/problem";
import { AUDIT_MODULE } from "../../../../modules/audit";
import type AuditModuleService from "../../../../modules/audit/service";

const Query = z
  .object({
    ...adminPageQuery,
    action: z.string().max(128).optional(),
    actor_id: z.string().max(128).optional(),
    resource_type: z.string().max(64).optional(),
    resource_id: z.string().max(256).optional(),
  })
  .strict();

/**
 * GET /admin/x/audit — đọc audit log (quyền `audit.read`), mới nhất trước, phân trang limit/offset (≤ 100/trang), lọc
 * theo action/actor/đối tượng. Chỉ đọc: không có route sửa/xoá (bảng chỉ ghi thêm, trigger DB chặn UPDATE/DELETE).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return sendProblem(res, 422, "VALIDATION", "Tham số không hợp lệ", zodErrors(parsed.error.issues));
  }
  const { limit, offset, ...filter } = parsed.data;
  const { entries, count } = await req.scope
    .resolve<AuditModuleService>(AUDIT_MODULE)
    .list(filter, { limit, offset });
  res.setHeader("Cache-Control", "no-store");
  res.json({ audit_logs: entries, count, limit, offset });
};
