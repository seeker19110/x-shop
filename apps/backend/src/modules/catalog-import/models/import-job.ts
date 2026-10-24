import { model } from "@medusajs/framework/utils";

/**
 * Một lần nhập CSV (ADM02): nội dung file + hash, kết quả preview (lỗi theo dòng/cột), người preview/commit và kết
 * quả ghi. Commit cùng import id lần hai trả lại kết quả đã lưu, không ghi lại (idempotent).
 */
const CatalogImportJob = model
  .define("catalog_import_job", {
    id: model.id({ prefix: "cimp" }).primaryKey(),
    file_hash: model.text(),
    file_name: model.text().nullable(),
    content: model.text(),
    status: model.enum(["previewed", "committed", "failed"]).default("previewed"),
    rows_total: model.number(),
    rows_valid: model.number(),
    errors: model.json(),
    summary: model.json(),
    result: model.json().nullable(),
    last_error: model.text().nullable(),
    previewed_by: model.text(),
    committed_by: model.text().nullable(),
    committed_at: model.dateTime().nullable(),
  })
  .indexes([{ on: ["file_hash"], where: "deleted_at IS NULL" }]);

export default CatalogImportJob;
