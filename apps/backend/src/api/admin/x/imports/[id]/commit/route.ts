import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { requirePermission } from "../../../../../../lib/access/require-permission";
import { commitImportJob } from "../../../../../../lib/catalog/import";
import {
  auditImportCommitted,
  auditImportFailed,
  auditImportRejected,
} from "../../../../../../lib/catalog/import-audit";
import { sendProblem } from "../../../../../../lib/http/problem";

/**
 * POST /admin/x/imports/:id/commit — ghi kế hoạch đã preview. Idempotent theo import id: gọi lại trả kết quả đã lưu
 * (`replayed: true`), không tạo trùng. Còn lỗi → 422 kèm lỗi theo dòng/cột. Ghi người commit (ADM02). Nhập giá và tồn
 * cần quyền riêng (gắn RBAC ở T-023). Audit: `catalog.import.committed` đúng một lần mỗi import (ghi trong khóa nhập),
 * `catalog.import.commit_rejected` khi còn lỗi, `catalog.import.commit_failed` khi lỗi giữa chừng.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const actorId = requirePermission(req, "catalog.import", "price.write", "inventory.adjust");
  const importId = req.params.id as string;
  let outcome: Awaited<ReturnType<typeof commitImportJob>>;
  try {
    outcome = await commitImportJob(req.scope, importId, actorId, auditImportCommitted(req));
  } catch (e) {
    if (!(e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND)) {
      // Ghi audit lỗi là nỗ lực tốt nhất — không che lỗi gốc.
      await auditImportFailed(req, importId, e).catch((auditError: Error) =>
        req.scope
          .resolve(ContainerRegistrationKeys.LOGGER)
          .error(`[import] Không ghi được audit commit lỗi: ${auditError.message}`),
      );
    }
    throw e;
  }
  if (outcome.kind === "has_errors") {
    await auditImportRejected(req, outcome.job, outcome.errors);
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
