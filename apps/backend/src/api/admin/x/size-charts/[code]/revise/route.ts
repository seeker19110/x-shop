import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { slugify } from "@x-shop/domain";
import { readCheckoutError, sendProblem as sendCheckoutProblem } from "../../../../../../lib/checkout/errors";
import { sendProblem, zodErrors } from "../../../../../../lib/http/problem";
import { SizeChartContentSchema } from "../../../../../../modules/fashion/validators";
import { reviseSizeChartWorkflow } from "../../../../../../workflows/fashion/size-chart";

/**
 * POST /admin/x/size-charts/:code/revise — tạo phiên bản mới (bản cũ giữ nguyên cho đơn cũ), chuyển sản phẩm sang
 * bản mới. Trả bản mới, bản bị thay và danh sách sản phẩm đã chuyển. Hạ tầng khóa (Redis) lỗi/không trả lời → 503
 * LOCK_UNAVAILABLE + Retry-After; khóa bận → 409 BUSY_RETRY (problem+json như route checkout).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = SizeChartContentSchema.safeParse(req.body);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const code = slugify(req.params.code as string);
  const run = await reviseSizeChartWorkflow(req.scope)
    .run({ input: { ...parsed.data, code } })
    .then(
      (r) => ({ ok: true as const, result: r.result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  if (!run.ok) {
    const lock = readCheckoutError(run.error);
    if (lock && (lock.code === "LOCK_UNAVAILABLE" || lock.code === "BUSY_RETRY")) {
      return sendCheckoutProblem(res, lock);
    }
    throw run.error;
  }
  const { result } = run;
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({
    size_chart: result.chart,
    superseded: result.previous,
    product_ids: result.product_ids,
  });
};
