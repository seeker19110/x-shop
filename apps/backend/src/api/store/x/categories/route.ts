import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { PUBLIC_CATALOG_CACHE } from "../../../../lib/catalog/listing";
import { CATALOG_INDEX_MODULE } from "../../../../modules/catalog-index";
import type CatalogIndexModuleService from "../../../../modules/catalog-index/service";
import { isNonEmpty } from "@x-shop/domain";

/**
 * GET /store/x/categories — danh mục đang có sản phẩm đã publish trong kênh bán của publishable key, kèm số sản phẩm
 * (đếm cả sản phẩm của danh mục con). Danh mục không có sản phẩm, không hoạt động hoặc nội bộ không xuất hiện
 * (menu storefront chỉ hiện nhóm có hàng — đặc tả §3.3). Thứ tự: rank rồi tên.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const index = req.scope.resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
  const [counts, cats] = await Promise.all([
    index.categoryCounts(req.publishable_key_context.sales_channel_ids),
    req.scope
      .resolve(Modules.PRODUCT)
      .listProductCategories(
        { is_active: true, is_internal: false },
        { select: ["id", "handle", "name", "parent_category_id", "rank"], take: null },
      ),
  ]);
  const countOf = new Map(counts.map((c) => [c.handle, c.count]));
  const handleOf = new Map(cats.map((c) => [c.id, c.handle]));
  const categories = cats
    .filter((c) => (countOf.get(c.handle) ?? 0) > 0)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name, "vi"))
    .map((c) => ({
      handle: c.handle,
      name: c.name,
      parent_handle: isNonEmpty(c.parent_category_id) ? (handleOf.get(c.parent_category_id) ?? null) : null,
      product_count: countOf.get(c.handle) as number,
    }));
  res.setHeader("Cache-Control", PUBLIC_CATALOG_CACHE);
  res.vary("x-publishable-api-key");
  res.json({ categories });
};
