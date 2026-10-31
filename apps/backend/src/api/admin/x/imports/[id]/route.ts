import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import { jobView } from "../../../../../lib/catalog/import";
import { sendProblem } from "../../../../../lib/http/problem";
import { CATALOG_IMPORT_MODULE } from "../../../../../modules/catalog-import";
import type CatalogImportModuleService from "../../../../../modules/catalog-import/service";
import { IdParams, readParams, sendParamNotFound } from "../../../../../lib/http/request-input";

/** GET /admin/x/imports/:id — trạng thái, lỗi, kết quả và người thao tác của một lần nhập. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  requirePermission(req, "catalog.import");
  const service: CatalogImportModuleService = req.scope.resolve(CATALOG_IMPORT_MODULE);
  const params = readParams(req, IdParams);
  if (!params.ok) return sendParamNotFound(res);
  const [job] = await service.listCatalogImportJobs({ id: params.data.id }, { take: 1 });
  if (!job) return sendProblem(res, 404, "NOT_FOUND", "Không có lần nhập này");
  res.setHeader("Cache-Control", "no-store");
  res.json(jobView(job as unknown as Parameters<typeof jobView>[0]));
};
