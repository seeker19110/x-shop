import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { requireOrderAccess, setPrivate } from "../../../../../../lib/orders/http";
import { handleReturnsRouteError } from "../../../../../../workflows/returns/errors";
import { idempotencyKeyOf, parseBody, ReturnRequestBody } from "../../../../../../workflows/returns/http";
import {
  assertReturnable,
  loadOrderContext,
  returnsOf,
} from "../../../../../../workflows/returns/order-context";
import { SYSTEM_AUDIT } from "../../../../../../workflows/returns/refunds";
import {
  isCarrierReturn,
  presentReturn,
  requestReturn,
  returnableLines,
} from "../../../../../../workflows/returns/returns";

/**
 * Đổi/trả của khách (POST03) — header `x-order-access` như mọi route đơn sau mua (token sai/thiếu → 404, AT20).
 * GET: dòng còn đổi/trả được + các yêu cầu và trạng thái (đã tiếp nhận → chờ gửi hàng → đã nhận → đã kiểm tra → kết
 * quả hoàn/đổi). POST: tạo yêu cầu theo dòng + số lượng, header `Idempotency-Key` (gửi lại → 200 yêu cầu cũ).
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const fin = await requireOrderAccess(req, "viewIpRef");
    const ctx = await loadOrderContext(req.scope, fin.order_id);
    let canRequest = true;
    try {
      assertReturnable(ctx, new Date());
    } catch {
      canRequest = false;
    }
    // Hàng hoàn từ hãng (T-045) là việc nội bộ của kho — khách chỉ thấy yêu cầu đổi/trả của chính mình.
    const returns = (await returnsOf(req.scope).listReturnsOfOrder(fin.order_id)).filter(
      (r) => !isCarrierReturn(r),
    );
    res.status(200).json({
      display_ref: fin.display_ref,
      can_request: canRequest,
      lines: await returnableLines(req.scope, ctx),
      returns: await Promise.all(returns.map((r) => presentReturn(req.scope, r, { customer: true }))),
    });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};

export const POST = async (req: MedusaStoreRequest, res: MedusaResponse): Promise<void> => {
  setPrivate(res);
  try {
    const key = idempotencyKeyOf(req);
    const body = parseBody(ReturnRequestBody, req.body);
    const fin = await requireOrderAccess(req, "cancelIpRef");
    const { ret, replayed } = await requestReturn(
      req.scope,
      {
        order_id: fin.order_id,
        kind: body.kind,
        reason: body.reason,
        note: body.note ?? null,
        lines: body.lines,
        channel: "customer",
        requested_by: null,
        idempotency_key: key,
      },
      { ...SYSTEM_AUDIT, actor_type: "customer" },
    );
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    res
      .status(replayed ? 200 : 201)
      .json({ return: await presentReturn(req.scope, ret, { customer: true }) });
  } catch (error) {
    handleReturnsRouteError(req, res, error);
  }
};
