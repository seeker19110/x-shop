import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CATEGORY_PAGE, listStoreCategories, PUBLIC_CATALOG_CACHE } from "../../../../lib/catalog/listing";
import { parseStorePage } from "../../../../lib/http/pagination";
import { sendProblem } from "../../../../lib/http/problem";
import { CATALOG_INDEX_MODULE } from "../../../../modules/catalog-index";
import type CatalogIndexModuleService from "../../../../modules/catalog-index/service";
import { isNonEmpty } from "@x-shop/domain";
import { readQueryBag, sendInvalidInput } from "../../../../lib/http/request-input";

/**
 * GET /store/x/categories[?limit=&offset=] — danh mục đang có sản phẩm đã publish trong kênh bán của publishable key,
 * kèm số sản phẩm (đếm cả sản phẩm của danh mục con). Danh mục không có sản phẩm, không hoạt động hoặc nội bộ không
 * xuất hiện (menu storefront chỉ hiện nhóm có hàng — đặc tả §3.3). Thứ tự: rank rồi tên. Phân trang `limit` (mặc định và
 * tối đa 200, lớn hơn bị kẹp) / `offset`; `count` = tổng số danh mục có hàng (XC-PERF-006).
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const bag = readQueryBag(req);
  if (!bag.ok) return sendInvalidInput(res, bag.errors);
  const { page, errors } = parseStorePage(bag.data, CATEGORY_PAGE);
  if (errors.length) return sendProblem(res, 422, "INVALID_QUERY", "Tham số phân trang không hợp lệ", errors);
  const index = req.scope.resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
  const [counts, cats] = await Promise.all([
    index.categoryCounts(req.publishable_key_context.sales_channel_ids),
    listStoreCategories(req.scope, ["id", "handle", "name", "parent_category_id", "rank"], (n) =>
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(`[catalog] /store/x/categories: chạm trần ${n} danh mục — danh mục ngoài trần không hiển thị`),
    ),
  ]);
  const countOf = new Map(counts.map((c) => [c.handle, c.count]));
  const handleOf = new Map(cats.map((c) => [c.id, c.handle]));
  const all = cats
    .filter((c) => (countOf.get(c.handle) ?? 0) > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name, "vi"));
  const categories = all.slice(page.offset, page.offset + page.limit).map((c) => ({
    handle: c.handle,
    name: c.name,
    parent_handle: isNonEmpty(c.parent_category_id) ? (handleOf.get(c.parent_category_id) ?? null) : null,
    product_count: countOf.get(c.handle) as number,
  }));
  res.setHeader("Cache-Control", PUBLIC_CATALOG_CACHE);
  res.vary("x-publishable-api-key");
  res.json({ categories, count: all.length, limit: page.limit, offset: page.offset });
};
