import {
  CHECKOUT_FORM_FIELDS,
  checkoutAddressFormSchema,
  checkoutFormSchema,
  normalizePhone,
  normalizeText,
  parseCheckoutForm,
  type CheckoutFormErrors,
  type CheckoutFormField,
} from "@x-shop/domain/validation";
import type { AddressInput, ContactInput } from "./types";

/**
 * Kiểm tra form checkout phía client bằng CHÍNH schema server dùng (`@x-shop/domain/validation` — subpath thuần, không
 * kéo tiền/sổ cái/máy trạng thái vào bundle; FE-FORM-001, Q-03 thay D-008). Server (Server Action + route backend)
 * vẫn kiểm lại và là nơi quyết định cuối.
 */
export type FieldName = CheckoutFormField;

/** Thứ tự DOM của các trường — lỗi đầu tiên theo thứ tự này nhận focus. */
export const FIELD_ORDER: readonly FieldName[] = CHECKOUT_FORM_FIELDS;

export type FieldErrors = CheckoutFormErrors;

export { normalizePhone, normalizeText };

export interface FormValues extends ContactInput, AddressInput {}

export function validateForm(v: FormValues): FieldErrors {
  const r = parseCheckoutForm(checkoutFormSchema, v);
  return r.ok ? {} : r.errors;
}

/** Đủ thông tin giao hàng để báo giá (không cần liên hệ). */
export function addressComplete(a: AddressInput): boolean {
  return checkoutAddressFormSchema.safeParse(a).success;
}

export function firstErrorField(errors: FieldErrors): FieldName | null {
  return FIELD_ORDER.find((f) => errors[f] !== undefined) ?? null;
}
