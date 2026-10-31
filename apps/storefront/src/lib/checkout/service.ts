import {
  checkoutQuoteInputSchema,
  checkoutSubmitInputSchema,
  parseCheckoutForm,
  type CheckoutFormParseResult,
} from "@x-shop/domain/validation";
import { readCartId } from "../cart/cookie";
import { StoreApiError, storeApi } from "../cart/medusa";
import { cartEnabled } from "../cart/service";
import { writeOrderAccess } from "../orders/cookie";
import { mapAttemptResponse, mapQuoteResponse, mapSubmitResponse } from "./map";
import type {
  AddressInput,
  PaymentMethod,
  PollResult,
  QuoteResult,
  SubmitInput,
  SubmitResult,
} from "./types";
import { isNonEmpty } from "../presence";

/**
 * Gọi `/store/x/checkout/*` từ server. Id giỏ LUÔN lấy từ cookie HttpOnly (không bao giờ từ client) nên khách A không
 * thể dùng giỏ của B; publishable key chỉ ở server. Mọi kết quả được chuẩn hóa — hàm không ném lỗi nghiệp vụ.
 * Đầu vào Server Action đến từ client nên là `unknown` thật sự: kiểm bằng schema chung (`@x-shop/domain/validation`,
 * FE-FORM-001) TRƯỚC khi đọc cookie/gọi backend — sai hình dạng (thiếu address/contact, null, mảng, mã giảm không phải
 * chuỗi) trả VALIDATION có `field`, không ném TypeError.
 */

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ID_RE = /^[\w-]{1,128}$/;

const NO_CART: QuoteResult = {
  ok: false,
  code: "CART_EMPTY",
  message: "Giỏ hàng đang trống hoặc đã hết hạn. Vui lòng chọn sản phẩm lại.",
};

const toBackendAddress = (a: AddressInput) => ({
  province_code: a.provinceCode,
  ward_code: a.wardCode,
  line: a.line,
});

/** Lỗi kiểm đầu vào → `{ code: "VALIDATION", message, field? }` (field = ô của form, để client gắn lỗi + focus). */
function validationOf(r: Extract<CheckoutFormParseResult<unknown>, { ok: false }>) {
  return {
    code: "VALIDATION" as const,
    message: r.message,
    ...(r.field !== undefined && { field: r.field }),
  };
}

/** Chạy một lời gọi Store API, trả (status, body, retry-after) kể cả khi lỗi nghiệp vụ. */
async function call(
  path: string,
  req: Parameters<typeof storeApi>[1],
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  try {
    const r = await storeApi<unknown>(path, req);
    return { status: r.status, body: r.data, retryAfter: null };
  } catch (e) {
    if (e instanceof StoreApiError) return { status: e.status, body: e.body, retryAfter: null };
    return { status: 0, body: null, retryAfter: null };
  }
}

export async function requestQuote(input: {
  paymentMethod: PaymentMethod;
  address: AddressInput;
  discountCode: string | null;
}): Promise<QuoteResult> {
  const parsed = parseCheckoutForm(checkoutQuoteInputSchema, input);
  if (!parsed.ok) return { ok: false, ...validationOf(parsed) };
  const { paymentMethod, address, discountCode } = parsed.data;
  if (!cartEnabled()) return NO_CART;
  const cartId = await readCartId();
  if (!isNonEmpty(cartId)) return NO_CART;
  const r = await call("/store/x/checkout/quote", {
    method: "POST",
    body: {
      cart_id: cartId,
      payment_method: paymentMethod,
      address: toBackendAddress(address),
      ...(discountCode !== null ? { discount_code: discountCode } : {}),
    },
  });
  return mapQuoteResponse(r.status, r.body);
}

export async function requestSubmit(input: SubmitInput): Promise<SubmitResult> {
  const raw: Partial<Record<keyof SubmitInput, unknown>> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  if (
    typeof raw.idempotencyKey !== "string" ||
    !KEY_RE.test(raw.idempotencyKey) ||
    typeof raw.quoteId !== "string" ||
    !ID_RE.test(raw.quoteId)
  ) {
    return {
      kind: "error",
      code: "VALIDATION",
      message: "Yêu cầu đặt hàng không hợp lệ. Vui lòng tải lại trang.",
      newKey: false,
    };
  }
  const { idempotencyKey, quoteId } = raw;
  const parsed = parseCheckoutForm(checkoutSubmitInputSchema, input);
  if (!parsed.ok) return { kind: "error", ...validationOf(parsed), newKey: false };
  const { cartVersion, paymentMethod, contact, address, discountCode } = parsed.data;
  if (!cartEnabled())
    return { kind: "error", code: "NOT_FOUND", message: NO_CART.ok ? "" : NO_CART.message, newKey: false };
  const cartId = await readCartId();
  if (!isNonEmpty(cartId))
    return { kind: "error", code: "NOT_FOUND", message: NO_CART.ok ? "" : NO_CART.message, newKey: false };
  const call1 = await call("/store/x/checkout/submit", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: {
      cart_id: cartId,
      cart_version: cartVersion,
      quote_id: quoteId,
      payment_method: paymentMethod,
      contact: {
        name: contact.name,
        phone: contact.phone,
        ...(contact.email !== null ? { email: contact.email } : {}),
      },
      address: toBackendAddress(address),
    },
  });
  const result = mapSubmitResponse(call1.status, call1.body, call1.retryAfter);
  if (result.kind === "placed") await rememberOrderAccess(result.ref, call1.body);
  // Giỏ đổi/báo giá hết hạn không kèm báo giá mới: lấy báo giá mới để khách xác nhận lại (không thu ngầm, CHK04).
  if (result.kind === "changed" && result.quote === null) {
    const fresh = await requestQuote({ paymentMethod, address, discountCode });
    return { ...result, quote: fresh.ok ? fresh.quote : null };
  }
  return result;
}

export async function requestAttempt(attemptId: string): Promise<PollResult> {
  if (!cartEnabled() || !ID_RE.test(attemptId ?? ""))
    return { kind: "failed", code: "NOT_FOUND", message: "Không tìm thấy lần đặt hàng." };
  const cartId = await readCartId();
  if (!isNonEmpty(cartId))
    return { kind: "failed", code: "NOT_FOUND", message: "Không tìm thấy lần đặt hàng." };
  const r = await call(
    `/store/x/checkout/attempts/${encodeURIComponent(attemptId)}?cart_id=${encodeURIComponent(cartId)}`,
    {},
  );
  const result = mapAttemptResponse(r.status, r.body);
  if (result.kind === "placed") await rememberOrderAccess(result.ref, r.body);
  return result;
}

/**
 * Đơn vừa tạo: đổi token phiên đơn của backend thành cookie HttpOnly (POST01) để xem `/don-hang/:ref` — token không
 * bao giờ tới trình duyệt qua JS hay URL. Lỗi ghi cookie không chặn luồng đặt hàng (khách vẫn tra cứu được).
 */
async function rememberOrderAccess(ref: string, body: unknown): Promise<void> {
  const b = (body ?? {}) as { order_access?: unknown; order_access_expires_at?: unknown };
  try {
    await writeOrderAccess(ref, b.order_access, b.order_access_expires_at);
  } catch {
    // ngoài ngữ cảnh ghi cookie (không phải Server Action) — bỏ qua
  }
}
