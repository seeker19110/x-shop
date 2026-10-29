import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { auditContextOf } from "../../../../lib/audit/record";
import { AdminReturnListQuery, listReturnsForAdmin } from "../../../../workflows/returns/admin-read";
import { handleReturnsRouteError } from "../../../../workflows/returns/errors";
import {
  actorOf,
  AdminReturnRequestBody,
  idempotencyKeyOf,
  parseBody,
  parseQuery,
} from "../../../../workflows/returns/http";
import { presentReturn, requestReturn } from "../../../../workflows/returns/returns";

/**
 * POST /admin/x/returns — CSKH tạo yêu cầu đổi/trả hộ khách (quyền `return.request`, POST03). Cùng quy tắc với khách:
 * đơn đã giao, theo dòng + số lượng không vượt số đã giao, `Idempotency-Key` bắt buộc.
 *
 * GET /admin/x/returns?state=&order_id=&source=request|carrier&limit=&offset= — danh sách cho kho (quyền
 * `return.receive`, T-049), mới nhất trước; `limit` 1–100 (mặc định 50), vượt khoảng/tham số lạ → 422. Yêu cầu hàng hoàn
 * từ hãng (T-045) có trong danh sách, đánh dấu `source: "carrier"`.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "return.request");
    const key = idempotencyKeyOf(req);
    const body = parseBody(AdminReturnRequestBody, req.body);
    const { ret, replayed } = await requestReturn(
      req.scope,
      {
        order_id: body.order_id,
        kind: body.kind,
        reason: body.reason,
        note: body.note ?? null,
        lines: body.lines,
        channel: "staff",
        requested_by: actor.id,
        idempotency_key: key,
      },
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    res
      .status(replayed ? 200 : 201)
      .json({ return: await presentReturn(req.scope, ret, { customer: false }) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};

export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    actorOf(req, "return.receive");
    const query = parseQuery(req, AdminReturnListQuery);
    const body = await listReturnsForAdmin(req.scope, query);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(body);
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
