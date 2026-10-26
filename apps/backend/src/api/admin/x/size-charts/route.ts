import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { slugify, isNonEmpty } from "@x-shop/domain";
import { sendProblem, zodErrors } from "../../../../lib/http/problem";
import { FASHION_MODULE } from "../../../../modules/fashion";
import type FashionModuleService from "../../../../modules/fashion/service";
import { SizeChartCreateSchema } from "../../../../modules/fashion/validators";
import { createSizeChartWorkflow } from "../../../../workflows/fashion/size-chart";

/** GET /admin/x/size-charts[?code=] — không có code: bản hiện hành của mọi bảng; có code: mọi phiên bản. */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const fashion: FashionModuleService = req.scope.resolve(FASHION_MODULE);
  const code = typeof req.query.code === "string" ? slugify(req.query.code) : null;
  // slug rỗng (code toàn ký tự lạ) coi như không lọc — giữ hành vi cũ.
  const charts = isNonEmpty(code)
    ? await fashion.listSizeCharts({ code }, { order: { version: "DESC" } })
    : await fashion.listSizeCharts({ superseded_at: null }, { order: { code: "ASC" } });
  res.setHeader("Cache-Control", "no-store");
  res.json({ size_charts: charts });
};

/** POST /admin/x/size-charts — tạo bảng size phiên bản 1. Đổi nội dung: POST /admin/x/size-charts/:code/revise. */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = SizeChartCreateSchema.safeParse(req.body);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  const { result } = await createSizeChartWorkflow(req.scope).run({ input: parsed.data });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ size_chart: result });
};
