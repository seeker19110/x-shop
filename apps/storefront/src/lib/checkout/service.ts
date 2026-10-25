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

/**
 * Gọi `/store/x/checkout/*` từ server. Id giỏ LUÔN lấy từ cookie HttpOnly (không bao giờ từ client) nên khách A không
 * thể dùng giỏ của B; publishable key chỉ ở server. Mọi kết quả được chuẩn hóa — hàm không ném lỗi nghiệp vụ.
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
  if (!cartEnabled()) return NO_CART;
  const cartId = await readCartId();
  if (!cartId) return NO_CART;
  if (input?.paymentMethod !== "cod" && input?.paymentMethod !== "vnpay") {
    return {
      ok: false,
      code: "VALIDATION",
      message: "Phương thức thanh toán không hợp lệ",
      field: "payment",
    };
  }
  const code = input.discountCode?.trim() ?? "";
  const r = await call("/store/x/checkout/quote", {
    method: "POST",
    body: {
      cart_id: cartId,
      payment_method: input.paymentMethod,
      address: toBackendAddress(input.address),
      ...(code !== "" ? { discount_code: code } : {}),
    },
  });
  return mapQuoteResponse(r.status, r.body);
}

export async function requestSubmit(input: SubmitInput): Promise<SubmitResult> {
  if (!cartEnabled())
    return { kind: "error", code: "NOT_FOUND", message: NO_CART.ok ? "" : NO_CART.message, newKey: false };
  const cartId = await readCartId();
  if (!cartId)
    return { kind: "error", code: "NOT_FOUND", message: NO_CART.ok ? "" : NO_CART.message, newKey: false };
  if (!KEY_RE.test(input?.idempotencyKey ?? "") || !ID_RE.test(input?.quoteId ?? "")) {
    return {
      kind: "error",
      code: "VALIDATION",
      message: "Yêu cầu đặt hàng không hợp lệ. Vui lòng tải lại trang.",
      newKey: false,
    };
  }
  const email = input.contact.email.trim();
  const call1 = await call("/store/x/checkout/submit", {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: {
      cart_id: cartId,
      cart_version: input.cartVersion,
      quote_id: input.quoteId,
      payment_method: input.paymentMethod,
      contact: { name: input.contact.name, phone: input.contact.phone, ...(email !== "" ? { email } : {}) },
      address: toBackendAddress(input.address),
    },
  });
  const result = mapSubmitResponse(call1.status, call1.body, call1.retryAfter);
  if (result.kind === "placed") await rememberOrderAccess(result.ref, call1.body);
  // Giỏ đổi/báo giá hết hạn không kèm báo giá mới: lấy báo giá mới để khách xác nhận lại (không thu ngầm, CHK04).
  if (result.kind === "changed" && result.quote === null) {
    const fresh = await requestQuote({
      paymentMethod: input.paymentMethod,
      address: input.address,
      discountCode: input.discountCode,
    });
    return { ...result, quote: fresh.ok ? fresh.quote : null };
  }
  return result;
}

export async function requestAttempt(attemptId: string): Promise<PollResult> {
  if (!cartEnabled() || !ID_RE.test(attemptId ?? ""))
    return { kind: "failed", code: "NOT_FOUND", message: "Không tìm thấy lần đặt hàng." };
  const cartId = await readCartId();
  if (!cartId) return { kind: "failed", code: "NOT_FOUND", message: "Không tìm thấy lần đặt hàng." };
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
