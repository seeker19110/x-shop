import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { isValidIdempotencyKey } from "@x-shop/domain";
import { auditContextOf } from "../../../../../lib/audit/record";
import { readCheckoutError, sendProblem as sendCheckoutProblem } from "../../../../../lib/checkout/errors";
import { sendProblem, zodErrors } from "../../../../../lib/http/problem";
import { AdjustError, AdjustmentBody, adjustInventory } from "../../../../../lib/inventory/adjust";

/**
 * POST /admin/x/inventory/adjustments — điều chỉnh tồn (quyền `inventory.adjust`, INV03). Header `Idempotency-Key`
 * (16–128 ký tự [A-Za-z0-9_-]) bắt buộc; gửi lại cùng khóa + cùng nội dung → 200 kết quả cũ (`Idempotent-Replayed`),
 * khác nội dung → 409 IDEMPOTENCY_CONFLICT. Giảm dưới số đang giữ → 409 BELOW_RESERVED. Khóa bận → 409 BUSY_RETRY.
 * Số giữ bị ghi đè đồng thời (hàng rào tồn T-185) → 409 INVENTORY_CONFLICT_RETRY.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", "no-store");
  const key = req.get("Idempotency-Key");
  if (!isValidIdempotencyKey(key)) {
    return sendProblem(res, 422, "VALIDATION", "Thiếu hoặc sai Idempotency-Key", [
      { param: "Idempotency-Key", reason: "16–128 ký tự [A-Za-z0-9_-]" },
    ]);
  }
  const parsed = AdjustmentBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return sendProblem(res, 422, "VALIDATION", "Dữ liệu không hợp lệ", zodErrors(parsed.error.issues));
  }
  try {
    const { replayed, adjustment } = await adjustInventory(req.scope, key, parsed.data, auditContextOf(req));
    const { payload_hash: _hash, ...body } = adjustment;
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return res.status(replayed ? 200 : 201).json({ adjustment: body });
  } catch (e) {
    if (e instanceof AdjustError) return sendProblem(res, e.status, e.code, e.message, [], e.extra);
    const busy = readCheckoutError(e);
    if (busy) return sendCheckoutProblem(res, busy);
    throw e;
  }
};
