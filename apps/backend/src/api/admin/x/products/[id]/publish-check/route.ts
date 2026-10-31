import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { loadProductSources } from "../../../../../../lib/catalog/product-source";
import { readinessOf } from "../../../../../../lib/catalog/publish-readiness";
import { sendProblem } from "../../../../../../lib/http/problem";
import { IdParams, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * GET /admin/x/products/:id/publish-check — danh sách vấn đề chặn xuất bản (ADM03, S-207) để Admin sửa hết một lần.
 * Cùng luật với hook chặn publish (product-publish-guard). Route /admin/* bắt buộc đăng nhập admin (Medusa).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const params = readParams(req, IdParams);
  if (!params.ok) return sendParamNotFound(res);
  const [product] = await loadProductSources(req.scope, { id: [params.data.id] });
  if (!product) return sendProblem(res, 404, "NOT_FOUND", "Không thấy sản phẩm");
  const issues = readinessOf(product);
  res.setHeader("Cache-Control", "no-store");
  res.json({ product_id: product.id, status: product.status, ready: issues.length === 0, issues });
};
