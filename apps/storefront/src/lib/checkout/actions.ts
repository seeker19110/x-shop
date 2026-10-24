"use server";

import { forgetCart } from "../cart/service";
import { requestAttempt, requestQuote, requestSubmit } from "./service";
import type {
  AddressInput,
  PaymentMethod,
  PollResult,
  QuoteResult,
  SubmitInput,
  SubmitResult,
} from "./types";

/**
 * Server Actions của checkout — mỏng, logic ở `service.ts`. Id giỏ đọc từ cookie ở server; client không gửi id giỏ.
 */

export async function quoteCheckout(input: {
  paymentMethod: PaymentMethod;
  address: AddressInput;
  discountCode: string | null;
}): Promise<QuoteResult> {
  return requestQuote(input);
}

export async function submitCheckout(input: SubmitInput): Promise<SubmitResult> {
  return requestSubmit(input);
}

export async function pollCheckout(attemptId: string): Promise<PollResult> {
  return requestAttempt(attemptId);
}

/** Sau khi đơn đã đặt thành công: bỏ cookie giỏ (giỏ đã đóng băng theo đơn) để lần mua sau dùng giỏ mới. */
export async function finishCheckout(): Promise<void> {
  await forgetCart();
}
