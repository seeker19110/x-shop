import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";
import { auditContextOf } from "../../../../lib/audit/record";
import { rejectWithoutRecentMfa } from "../../../../lib/admin-security/guard";
import { readQuery, readQueryBag } from "../../../../lib/http/request-input";
import { RETURNS_CONFIG } from "../../../../modules/returns/constants";
import { AdminRefundQueueQuery, refundQueueForAdmin } from "../../../../workflows/returns/admin-read";
import { handleReturnsRouteError, ReturnsError } from "../../../../workflows/returns/errors";
import {
  actorOf,
  idempotencyKeyOf,
  parseBody,
  parseQuery,
  RefundCreateBody,
} from "../../../../workflows/returns/http";
import { createRefund, presentRefund, refundSummary } from "../../../../workflows/returns/refunds";

/**
 * POST /admin/x/refunds — tạo yêu cầu hoàn tiền (quyền `refund.request`; kho không có → 403, AT21). Header
 * `Idempotency-Key` bắt buộc (gửi lại → 200 bản cũ, khác nội dung → 409). Σ hoàn ≤ Σ đã thu kể cả các yêu cầu đang
 * giữ (422 REFUND_EXCEEDS_CAPTURED). Vượt ngưỡng (hoặc hoàn toàn bộ khi hủy đơn) → đòi xác thực lại MFA ≤ 5 phút và
 * người thứ hai duyệt (S-402, S-403). Hoàn theo trả hàng được tạo tự động khi kiểm định; chỉ khi bản đó đã bị hủy
 * (`failed → cancelled`, T-044) mới mở lại ở đây bằng `reason=return` + `return_id` (số tiền theo kiểm định).
 *
 * GET /admin/x/refunds?order_id=… — đã thu / đã hoàn / đang giữ / còn hoàn được + danh sách yêu cầu của đơn (chỉ
 * `order_id`; kèm tham số khác → 422).
 * GET /admin/x/refunds?state=requested[&limit=&offset=] — hàng đợi trên mọi đơn theo trạng thái (T-049), cũ nhất
 * trước; `state` bắt buộc khi không có `order_id`, `limit` 1–100 (mặc định 50), vượt khoảng/tham số lạ → 422.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    const actor = actorOf(req, "refund.request");
    const key = idempotencyKeyOf(req);
    const body = parseBody(RefundCreateBody, req.body);
    const large = body.amount === undefined || body.amount > RETURNS_CONFIG.refundApprovalThresholdVnd;
    if (large && rejectWithoutRecentMfa(req, res)) return;
    const { refund, replayed } = await createRefund(
      req.scope,
      {
        order_id: body.order_id,
        reason: body.reason,
        return_id: body.return_id ?? null,
        amount: body.amount ?? null,
        method: body.method ?? "auto",
        note: body.note ?? null,
        idempotency_key: key,
      },
      actor,
      auditContextOf(req),
    );
    res.setHeader("Cache-Control", "no-store");
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    res.status(replayed ? 200 : 201).json({ refund: presentRefund(refund) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};

export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  try {
    actorOf(req, "refund.request");
    const bag = readQueryBag(req);
    if (!bag.ok) throw new ReturnsError("VALIDATION", "Dữ liệu không hợp lệ", { errors: bag.errors });
    if (!Object.prototype.hasOwnProperty.call(bag.data, "order_id")) {
      const query = parseQuery(req, AdminRefundQueueQuery);
      const body = await refundQueueForAdmin(req.scope, query);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(body);
      return;
    }
    const mixed = Object.keys(bag.data).filter((k) => k !== "order_id");
    if (mixed.length > 0) {
      throw new ReturnsError("VALIDATION", "order_id không dùng kèm tham số hàng đợi", {
        errors: mixed.map((param) => ({ param, reason: "không dùng kèm order_id" })),
      });
    }
    const lookup = readQuery(req, z.object({ order_id: z.string().trim().min(1).max(128) }));
    if (!lookup.ok) {
      throw new ReturnsError("VALIDATION", "Cần order_id", { field: "order_id" });
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await refundSummary(req.scope, lookup.data.order_id));
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
