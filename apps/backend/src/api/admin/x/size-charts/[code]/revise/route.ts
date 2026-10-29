import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { slugify } from "@x-shop/domain";
import { z } from "zod";
import { readCheckoutError, sendProblem as sendCheckoutProblem } from "../../../../../../lib/checkout/errors";
import { sendProblem, zodErrors } from "../../../../../../lib/http/problem";
import { SizeChartContentSchema } from "../../../../../../modules/fashion/validators";
import { reviseSizeChartWorkflow } from "../../../../../../workflows/fashion/size-chart";
import { pathId, readParams, sendParamNotFound } from "../../../../../../lib/http/request-input";

/**
 * POST /admin/x/size-charts/:code/revise — tạo phiên bản mới (bản cũ giữ nguyên cho đơn cũ), chuyển sản phẩm sang
 * bản mới. Trả bản mới, bản bị thay và danh sách sản phẩm đã chuyển. Hạ tầng khóa (Redis) lỗi/không trả lời → 503
 * LOCK_UNAVAILABLE + Retry-After; khóa bận → 409 BUSY_RETRY (problem+json như route checkout).
 */
const CodeParams = z.object({ code: pathId(60) });

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = SizeChartContentSchema.safeParse(req.body);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const params = readParams(req, CodeParams);
  if (!params.ok) return sendParamNotFound(res);
  const code = slugify(params.data.code);
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
