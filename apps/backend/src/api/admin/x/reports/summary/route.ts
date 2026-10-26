import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { requirePermission } from "../../../../../lib/access/require-permission";
import {
  handleSettlementError,
  parseInput,
  settlementOf,
  SummaryQuery,
} from "../../../../../lib/settlement/http";

/**
 * GET /admin/x/reports/summary[?from=…&to=…] — báo cáo tiền TÁCH theo định nghĩa (§5.5, S-406; quyền `report.read`):
 * đơn theo trạng thái, giá trị đơn, đã thu theo hệ thống (cổng + COD đã giao), thực nhận theo chứng từ đối soát, đã
 * hoàn, COD phải nhận (AT14), chênh lệch còn mở. Mỗi chỉ số lọc theo thời điểm phát sinh của chính nó trong [from, to).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    requirePermission(req, "report.read");
    const q = parseInput(SummaryQuery, req.query);
    const report = await settlementOf(req).reportSummary({ from: q.from ?? null, to: q.to ?? null });
    res.setHeader("Cache-Control", "no-store");
    res.json(report);
  } catch (error) {
    handleSettlementError(req, res, error);
  }
};
