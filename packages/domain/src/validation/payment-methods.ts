/**
 * Phương thức thanh toán — MỘT nguồn cho schema checkout (`checkout.ts`), hằng module backend, outbox và kiểu/telemetry
 * storefront (T-188). Cố ý KHÔNG import gì (kể cả zod): entry client chỉ cần hằng này (vd `analytics/schema.ts`) không
 * kéo schema/zod vào bundle (test: `validation.test.ts`, storefront `client-bundle.test.ts`).
 */
export const CHECKOUT_PAYMENT_METHODS = ["cod", "vnpay"] as const;
export type CheckoutPaymentMethod = (typeof CHECKOUT_PAYMENT_METHODS)[number];
