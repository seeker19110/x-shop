import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { returnDetailForAdmin } from "../../../../../workflows/returns/admin-read";
import { handleReturnsRouteError } from "../../../../../workflows/returns/errors";
import { actorOf } from "../../../../../workflows/returns/http";
import { IdParams, readParams, sendParamNotFound } from "../../../../../lib/http/request-input";

/**
 * GET /admin/x/returns/:id — chi tiết yêu cầu đổi/trả cho kho (quyền `return.receive`, T-049): dòng hàng (tên sản phẩm,
 * số yêu cầu/đã nhận, kết quả kiểm định + ghi chú, tiền hoàn theo dòng), hoàn tiền liên kết, `source` (request|carrier).
 * Không có → 404 NOT_FOUND. Không trả liên hệ/địa chỉ khách.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    actorOf(req, "return.receive");
    const params = readParams(req, IdParams);
    if (!params.ok) return sendParamNotFound(res);
    const ret = await returnDetailForAdmin(req.scope, params.data.id);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ return: ret });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
