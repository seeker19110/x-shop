import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import { MAX_IMPORT_BYTES, recordPreview } from "../../../../../lib/catalog/import";
import { auditImportPreview } from "../../../../../lib/catalog/import-audit";
import { readCsvBody } from "../../../../../lib/http/read-body";
import { sendProblem } from "../../../../../lib/http/problem";

/**
 * POST /admin/x/imports/preview — nhận CSV (`text/csv` hoặc multipart trường `file`, tối đa 2 MB), kiểm từng dòng
 * (S-206), lưu import_job để commit sau; KHÔNG ghi gì vào catalog. Trả dòng hợp lệ + lỗi theo dòng/cột. Ghi audit
 * `catalog.import.previewed` (băm file + số đếm, không nội dung/tên file).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const actorId = requirePermission(req, "catalog.import");
  const body = await readCsvBody(req, MAX_IMPORT_BYTES);
  if (!body.ok) return sendProblem(res, body.status, body.code, body.reason);
  const { job, rows } = await recordPreview(req.scope, {
    text: body.text,
    bytes: body.bytes,
    fileName: body.fileName,
    actorId,
  });
  await auditImportPreview(req, job);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ ...job, rows, can_commit: job.errors.length === 0 && rows.length > 0 });
};
