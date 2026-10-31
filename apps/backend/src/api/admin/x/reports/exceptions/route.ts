import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import {
  ExceptionsQuery,
  handleSettlementError,
  parseQuery,
  settlementOf,
} from "../../../../../lib/settlement/http";

/**
 * GET /admin/x/reports/exceptions[?source=ops|settlement|cod&kind=…&priority=…&limit&offset] — dashboard ngoại lệ (§5.5,
 * S-406; quyền `exception.read`): ngoại lệ vận hành còn mở (late_payment, overpayment, payment/refund unknown, webhook
 * rejected…), chênh lệch đối soát còn mở và COD đã giao chưa đối soát đủ — mỗi mục có owner/vai trò phụ trách, ưu tiên,
 * thời điểm mở, tuổi (giây). Ưu tiên cao trước, cũ trước. `by_kind` = số mục + tiền theo loại.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "exception.read");
    const { limit, offset, ...filter } = parseQuery(req, ExceptionsQuery);
    const result = await settlementOf(req).listExceptions(filter, { limit, offset });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...result, limit, offset });
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
