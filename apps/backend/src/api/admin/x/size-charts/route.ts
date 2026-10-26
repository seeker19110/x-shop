import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { slugify, isNonEmpty } from "@x-shop/domain";
import { z } from "zod";
import { adminPageQuery } from "../../../../lib/http/pagination";
import { sendProblem, zodErrors } from "../../../../lib/http/problem";
import { FASHION_MODULE } from "../../../../modules/fashion";
import type FashionModuleService from "../../../../modules/fashion/service";
import { SizeChartCreateSchema } from "../../../../modules/fashion/validators";
import { createSizeChartWorkflow } from "../../../../workflows/fashion/size-chart";

const ListQuery = z.object({ code: z.string().max(200).optional(), ...adminPageQuery }).strict();

/**
 * GET /admin/x/size-charts[?code=&limit=&offset=] — không có code: bản hiện hành của mọi bảng; có code: mọi phiên bản.
 * Phân trang như mọi danh sách Admin (`limit` 1–100, mặc định 50; vượt khoảng/tham số lạ → 422 — XC-PERF-006).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success)
    return sendProblem(res, 422, "VALIDATION", "Tham số không hợp lệ", zodErrors(parsed.error.issues));
  const { limit, offset } = parsed.data;
  const fashion: FashionModuleService = req.scope.resolve(FASHION_MODULE);
  const code = parsed.data.code === undefined ? null : slugify(parsed.data.code);
  // slug rỗng (code toàn ký tự lạ) coi như không lọc — giữ hành vi cũ.
  const [charts, count] = isNonEmpty(code)
    ? await fashion.listAndCountSizeCharts(
        { code },
        { order: { version: "DESC" }, take: limit, skip: offset },
      )
    : await fashion.listAndCountSizeCharts(
        { superseded_at: null },
        { order: { code: "ASC" }, take: limit, skip: offset },
      );
  res.setHeader("Cache-Control", "no-store");
  res.json({ size_charts: charts, count, limit, offset });
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
