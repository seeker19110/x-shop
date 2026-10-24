import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { loadProductSources } from "../../../../../../lib/catalog/product-source";
import { sendProblem, zodErrors } from "../../../../../../lib/http/problem";
import { ProductFashionSchema } from "../../../../../../modules/fashion/validators";
import { setProductFashionWorkflow } from "../../../../../../workflows/fashion/set-product-fashion";

/**
 * POST /admin/x/products/:id/fashion — đặt thuộc tính thời trang, bảng size, số đo người mẫu (ADM01, PDP03–04).
 * Sản phẩm đang published mà thay đổi làm mất điều kiện xuất bản → bị từ chối và hoàn tác.
 * Quyền chi tiết (catalog.write) gắn ở T-023; hiện route /admin/* đòi đăng nhập admin.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = ProductFashionSchema.safeParse(req.body);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const id = req.params.id as string;
  await setProductFashionWorkflow(req.scope).run({ input: { ...parsed.data, product_id: id } });
  const [product] = await loadProductSources(req.scope, { id: [id] });
  res.setHeader("Cache-Control", "no-store");
  res.json({
    product_id: id,
    attributes: product?.attributes ?? null,
    size_chart: product?.sizeChart ?? null,
  });
};
