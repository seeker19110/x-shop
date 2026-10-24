import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { slugify } from "@x-shop/domain";
import { sendProblem, zodErrors } from "../../../../../../lib/http/problem";
import { SizeChartContentSchema } from "../../../../../../modules/fashion/validators";
import { reviseSizeChartWorkflow } from "../../../../../../workflows/fashion/size-chart";

/**
 * POST /admin/x/size-charts/:code/revise — tạo phiên bản mới (bản cũ giữ nguyên cho đơn cũ), chuyển sản phẩm sang
 * bản mới. Trả bản mới, bản bị thay và danh sách sản phẩm đã chuyển.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = SizeChartContentSchema.safeParse(req.body);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const code = slugify(req.params.code as string);
  const { result } = await reviseSizeChartWorkflow(req.scope).run({ input: { ...parsed.data, code } });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({
    size_chart: result.chart,
    superseded: result.previous,
    product_ids: result.product_ids,
  });
};
