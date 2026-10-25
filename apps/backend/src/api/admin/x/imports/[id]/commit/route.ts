import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { commitImportJob } from "../../../../../../lib/catalog/import";
import { sendProblem } from "../../../../../../lib/http/problem";

/**
 * POST /admin/x/imports/:id/commit — ghi kế hoạch đã preview. Idempotent theo import id: gọi lại trả kết quả đã lưu
 * (`replayed: true`), không tạo trùng. Còn lỗi → 422 kèm lỗi theo dòng/cột. Ghi người commit (ADM02). Nhập giá và tồn
 * cần quyền riêng (gắn RBAC ở T-023).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const actorId = requirePermission(req, "catalog.import", "price.write", "inventory.adjust");
  const outcome = await commitImportJob(req.scope, req.params.id as string, actorId);
  if (outcome.kind === "has_errors") {
    return sendProblem(
      res,
      422,
      "IMPORT_HAS_ERRORS",
      "File nhập còn lỗi — sửa rồi preview lại",
      outcome.errors.map((e) => ({ param: `line ${e.line}: ${e.column}`, reason: e.message })),
      { import_id: outcome.job.import_id, rows: outcome.errors },
    );
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...outcome.job, replayed: outcome.replayed });
};
