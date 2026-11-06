import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { PUBLIC_CATALOG_CACHE } from "../../../../../lib/catalog/listing";
import { loadProductDetail } from "../../../../../lib/catalog/product-detail";
import { sendProblem } from "../../../../../lib/http/problem";
import { z } from "zod";
import { pathId, readParams } from "../../../../../lib/http/request-input";

/**
 * GET /store/x/products/:handle — chi tiết sản phẩm cho PDP (biến thể, giá, tồn, ảnh theo màu, bảng size, thuộc tính).
 * Không có, bản nháp, hoặc không thuộc kênh của publishable key → 404.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const params = readParams(req, z.object({ handle: pathId(200) }));
  if (!params.ok) return sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy sản phẩm");
  const { handle } = params.data;
  const detail = await loadProductDetail(req.scope, handle, req.publishable_key_context.sales_channel_ids);
  if (!detail) return sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy sản phẩm");
  res.setHeader("Cache-Control", PUBLIC_CATALOG_CACHE);
  res.vary("x-publishable-api-key");
  res.json(detail);
};
