import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { searchKey } from "@x-shop/domain";
import { parseListingQuery, PUBLIC_CATALOG_CACHE, runListing } from "../../../../lib/catalog/listing";
import { sendProblem } from "../../../../lib/http/problem";

const SUGGESTION_LIMIT = 6;

/**
 * GET /store/x/search?q= — cùng truy vấn với danh sách (tìm tên/SKU/danh mục có/không dấu, CAT01; q dài hơn 100 ký tự
 * bị cắt). Không có kết quả → gợi ý danh mục liên quan (khớp từ khoá), không thì danh mục gốc.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const { request, errors } = parseListingQuery(req.query);
  if (errors.length) return sendProblem(res, 422, "INVALID_QUERY", "Tham số tìm kiếm không hợp lệ", errors);
  const result = await runListing(req.scope, req.publishable_key_context.sales_channel_ids, request);
  let suggestions: { categories: { handle: string; name: string }[] } = { categories: [] };
  if (result.total === 0) {
    const cats = await req.scope
      .resolve(Modules.PRODUCT)
      .listProductCategories(
        { is_active: true, is_internal: false },
        { select: ["handle", "name", "parent_category_id", "rank"], take: null },
      );
    const terms = searchKey(request.filter.q ?? "")
      .split(" ")
      .filter(Boolean);
    const related = cats.filter((c) => {
      const words = searchKey(c.name).split(" ").filter(Boolean);
      return terms.some((t) => words.some((w) => w.startsWith(t) || t.startsWith(w)));
    });
    const pick = (related.length ? related : cats.filter((c) => !c.parent_category_id))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name, "vi"))
      .slice(0, SUGGESTION_LIMIT);
    suggestions = { categories: pick.map((c) => ({ handle: c.handle, name: c.name })) };
  }
  res.setHeader("Cache-Control", PUBLIC_CATALOG_CACHE);
  res.vary("x-publishable-api-key");
  res.json({ ...result, query: request.filter.q, suggestions });
};
