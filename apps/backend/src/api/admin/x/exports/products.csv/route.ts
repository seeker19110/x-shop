import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import { exportProductsCsv } from "../../../../../lib/catalog/import";

/**
 * GET /admin/x/exports/products.csv — xuất catalog cùng định dạng nhập; ô có thể bị hiểu là công thức (= + - @) được
 * vô hiệu bằng tiền tố ' (toCsv của domain, S-206). Dữ liệu quản trị: không cache.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  requirePermission(req, "catalog.read");
  const csv = await exportProductsCsv(req.scope);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="products.csv"');
  res.setHeader("Cache-Control", "no-store");
  res.send(csv);
};
