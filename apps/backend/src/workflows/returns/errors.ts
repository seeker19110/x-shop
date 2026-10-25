import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { readCheckoutError, sendProblem as sendCheckoutProblem } from "../../lib/checkout/errors";
import { sendProblem } from "../../lib/http/problem";
import { AdjustError } from "../../lib/inventory/adjust";

/**
 * Lỗi đổi trả/hoàn tiền có mã ổn định → `application/problem+json` (đặc tả §9.1). Mã 409 = trạng thái không cho phép
 * thao tác (gọi lại sau hoặc xem trạng thái hiện tại); 422 = dữ liệu sai.
 */
export const RETURNS_ERROR_STATUS = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  NOT_RETURNABLE: 409,
  QUANTITY_EXCEEDS_DELIVERED: 422,
  RETURN_WINDOW_EXPIRED: 409,
  INVALID_STATE: 409,
  EXCHANGE_INVALID_VARIANT: 422,
  EXCHANGE_PRICE_DIFFERS: 422,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REFUND_EXCEEDS_CAPTURED: 422,
  REFUND_SPLIT_REQUIRED: 422,
  REFUND_METHOD_UNAVAILABLE: 422,
  REFUND_NOT_APPROVED: 409,
  SELF_APPROVAL: 403,
  FORBIDDEN: 403,
  REFUND_PROVIDER_DISABLED: 409,
  REFUND_IN_PROGRESS: 409,
  REFUND_RETRY_EXHAUSTED: 409,
  REFUND_PROVIDER_UNCONFIRMED: 409,
  BUSY_RETRY: 409,
} as const;

export type ReturnsErrorCode = keyof typeof RETURNS_ERROR_STATUS;

export class ReturnsError extends Error {
  override readonly name = "ReturnsError";
  readonly status: number;
  constructor(
    readonly code: ReturnsErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = RETURNS_ERROR_STATUS[code];
  }
}

/** Lỗi route đổi trả/hoàn tiền → problem+json; lỗi khóa bận của checkout → 409 BUSY_RETRY có Retry-After. */
export function handleReturnsRouteError(req: MedusaRequest, res: MedusaResponse, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  if (error instanceof ReturnsError) {
    if (
      error.code === "BUSY_RETRY" ||
      error.code === "REFUND_IN_PROGRESS" ||
      error.code === "REFUND_PROVIDER_UNCONFIRMED"
    )
      res.setHeader("Retry-After", "2");
    return sendProblem(res, error.status, error.code, error.message, [], error.detail);
  }
  if (error instanceof AdjustError)
    return sendProblem(res, error.status, error.code, error.message, [], error.extra);
  const checkout = readCheckoutError(error);
  if (checkout && checkout.code !== "INTERNAL") return sendCheckoutProblem(res, checkout);
  if (error instanceof MedusaError) {
    const status =
      error.type === MedusaError.Types.UNAUTHORIZED
        ? 401
        : error.type === MedusaError.Types.FORBIDDEN
          ? 403
          : 0;
    if (status) return sendProblem(res, status, status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", error.message);
  }
  req.scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .error(`[returns] ${req.method} ${req.path}: ${error instanceof Error ? error.stack : "lỗi không rõ"}`);
  sendProblem(res, 500, "INTERNAL", "Không thể xử lý yêu cầu lúc này");
}
