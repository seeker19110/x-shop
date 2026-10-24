import type { AddressInput, ContactInput } from "./types";

/**
 * Kiểm tra form phía client (phản chiếu `normalizeVnPhone`/`validateAddress` của `@x-shop/domain`, có test đối chiếu —
 * D-008: client không import giá trị từ domain). Server vẫn kiểm lại và là nơi quyết định cuối.
 */
export type FieldName = "name" | "phone" | "email" | "province" | "ward" | "line" | "discount" | "payment";

/** Thứ tự DOM của các trường — lỗi đầu tiên theo thứ tự này nhận focus. */
export const FIELD_ORDER: readonly FieldName[] = [
  "name",
  "phone",
  "email",
  "province",
  "ward",
  "line",
  "discount",
  "payment",
];

export type FieldErrors = Partial<Record<FieldName, string>>;

const PHONE_RE = /^(0|\+84)(3|5|7|8|9)\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Số di động VN → dạng chuẩn 0xxxxxxxxx; sai → null. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s.()-]/g, "");
  if (!PHONE_RE.test(s)) return null;
  return s.startsWith("+84") ? `0${s.slice(3)}` : s;
}

export function normalizeText(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ");
}

export interface FormValues extends ContactInput, AddressInput {}

export function validateForm(v: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  if (normalizeText(v.name) === "") errors.name = "Vui lòng nhập họ tên";
  else if ([...normalizeText(v.name)].length > 100) errors.name = "Họ tên quá dài (tối đa 100 ký tự)";
  if (normalizePhone(v.phone) === null) errors.phone = "Số điện thoại không hợp lệ. Ví dụ: 0912 345 678";
  const email = v.email.trim();
  if (email !== "" && (email.length > 254 || !EMAIL_RE.test(email))) errors.email = "Email không hợp lệ";
  if (v.provinceCode === "") errors.province = "Vui lòng chọn tỉnh/thành phố";
  if (v.wardCode === "") errors.ward = "Vui lòng chọn phường/xã";
  const line = normalizeText(v.line);
  if ([...line].length < 3) errors.line = "Vui lòng nhập số nhà, tên đường";
  else if ([...line].length > 200) errors.line = "Địa chỉ quá dài (tối đa 200 ký tự)";
  return errors;
}

/** Đủ thông tin giao hàng để báo giá (không cần liên hệ). */
export function addressComplete(a: AddressInput): boolean {
  return (
    a.provinceCode !== "" &&
    a.wardCode !== "" &&
    [...normalizeText(a.line)].length >= 3 &&
    [...normalizeText(a.line)].length <= 200
  );
}

export function firstErrorField(errors: FieldErrors): FieldName | null {
  return FIELD_ORDER.find((f) => errors[f] !== undefined) ?? null;
}
