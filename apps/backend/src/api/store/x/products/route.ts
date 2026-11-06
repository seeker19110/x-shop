import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { parseListingQuery, PUBLIC_CATALOG_CACHE, runListing } from "../../../../lib/catalog/listing";
import { sendProblem } from "../../../../lib/http/problem";
import { readQueryBag, sendInvalidInput } from "../../../../lib/http/request-input";

/**
 * GET /store/x/products — danh sách lọc cùng SKU từ read model (S-201, S-202, CAT02–04).
 * Tham số theo allowlist của `parseFilter` (q, color, size, material, price_min, price_max, in_stock, sort, page) +
 * `category`, `page_size` (kẹp ≤ 48). Tham số sai hoặc price_min > price_max → 422 problem+json.
 * Kênh bán lấy từ publishable key (Medusa bắt buộc header `x-publishable-api-key` cho /store/*).
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const bag = readQueryBag(req);
  if (!bag.ok) return sendInvalidInput(res, bag.errors);
  const { request, errors } = parseListingQuery(bag.data);
  if (errors.length) return sendProblem(res, 422, "INVALID_QUERY", "Tham số lọc không hợp lệ", errors);
  const result = await runListing(req.scope, req.publishable_key_context.sales_channel_ids, request);
  res.setHeader("Cache-Control", PUBLIC_CATALOG_CACHE);
  res.vary("x-publishable-api-key");
  res.json(result);
};
