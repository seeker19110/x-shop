import * as z from "zod/mini";
import { CHECKOUT_PAYMENT_METHODS } from "./payment-methods.js";
import { normalizePhone } from "./phone.js";
import { charLength, normalizeText } from "./text.js";

/**
 * Schema form checkout — MỘT nguồn cho form ở trình duyệt (CheckoutForm), Server Action của storefront và route
 * `/store/x/checkout/{quote,submit}` của backend (FE-FORM-001, Q-03). Dùng `zod/mini` (tree-shake được) và chỉ import
 * `./payment-methods`, `./phone`, `./text`: subpath `@x-shop/domain/validation` không kéo tiền/sổ cái/máy trạng thái/provider vào bundle
 * client (test: storefront `client-bundle.test.ts`).
 *
 * Hai hình dạng cùng ghép từ MỘT bộ schema trường:
 *  - wire (snake_case) — thân request backend: `checkoutQuoteRequestSchema`, `checkoutSubmitRequestSchema`;
 *  - form (camelCase) — giá trị form và đầu vào Server Action: `checkoutFormSchema`, `checkoutQuoteInputSchema`,
 *    `checkoutSubmitInputSchema`.
 * Kiểm mã tỉnh/xã có trong danh mục (đọc file dữ liệu) vẫn là việc của server (`validateAddress`).
 */

export const CHECKOUT_LIMITS = {
  nameMax: 100,
  lineMin: 3,
  lineMax: 200,
  /** Chiều dài thô tối đa của ô địa chỉ trước khi chuẩn hoá (chặn chuỗi khổng lồ). */
  lineRawMax: 500,
  emailMax: 254,
  phoneRawMax: 32,
  geoCodeMax: 10,
  discountCodeMax: 64,
  idMax: 100,
  cartVersionMax: 1_000_000,
} as const;

/** Thông điệp lỗi theo trường (nói cách sửa — FE-FORM-002). */
export const CHECKOUT_MESSAGES = {
  name: "Vui lòng nhập họ tên",
  nameTooLong: `Họ tên quá dài (tối đa ${CHECKOUT_LIMITS.nameMax} ký tự)`,
  phone: "Số điện thoại không hợp lệ. Ví dụ: 0912 345 678",
  email: "Email không hợp lệ",
  province: "Vui lòng chọn tỉnh/thành phố",
  ward: "Vui lòng chọn phường/xã",
  line: "Vui lòng nhập số nhà, tên đường",
  lineTooLong: `Địa chỉ quá dài (tối đa ${CHECKOUT_LIMITS.lineMax} ký tự)`,
  discount: "Mã giảm giá không hợp lệ",
  payment: "Phương thức thanh toán không hợp lệ",
  contact: "Thiếu thông tin liên hệ",
  address: "Thiếu địa chỉ giao hàng",
  cartId: "Thiếu mã giỏ hàng",
  cartVersion: "Phiên bản giỏ không hợp lệ",
  quoteId: "Thiếu mã báo giá",
  unknownKey: "Có trường không được chấp nhận trong yêu cầu",
  invalid: "Dữ liệu chưa hợp lệ",
} as const;

const M = CHECKOUT_MESSAGES;
const L = CHECKOUT_LIMITS;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------------------------------- schema theo trường */

/** Họ tên: chuẩn hoá (NFC, gọn khoảng trắng), 1–100 ký tự. */
export const contactNameSchema = z.string({ error: M.name }).check(
  z.overwrite(normalizeText),
  z.minLength(1, M.name),
  z.refine((s) => charLength(s) <= L.nameMax, M.nameTooLong),
);

/** Số di động VN → dạng chuẩn 0xxxxxxxxx (đầu ra đã chuẩn hoá). */
export const vnPhoneSchema = z.string({ error: M.phone }).check(
  z.maxLength(L.phoneRawMax, M.phone),
  z.refine((s) => normalizePhone(s) !== null, M.phone),
  z.overwrite((s) => normalizePhone(s) ?? s),
);

/** Email không bắt buộc: vắng/null/rỗng → null; có thì đúng dạng, ≤ 254 ký tự, đưa về chữ thường. */
export const optionalEmailSchema = z
  .pipe(
    z.nullish(z.string({ error: M.email })),
    z.transform((v) => {
      const s = (v ?? "").trim();
      return s === "" ? null : s.toLowerCase();
    }),
  )
  .check(z.refine((v) => v === null || (v.length <= L.emailMax && EMAIL_RE.test(v)), M.email));

const geoCode = (message: string) =>
  z.string({ error: message }).check(z.trim(), z.minLength(1, message), z.maxLength(L.geoCodeMax, message));

export const provinceCodeSchema = geoCode(M.province);
export const wardCodeSchema = geoCode(M.ward);

/** Số nhà, tên đường: chuẩn hoá rồi 3–200 ký tự. */
export const addressLineSchema = z.string({ error: M.line }).check(
  z.maxLength(L.lineRawMax, M.lineTooLong),
  z.overwrite(normalizeText),
  z.refine((s) => charLength(s) >= L.lineMin, M.line),
  z.refine((s) => charLength(s) <= L.lineMax, M.lineTooLong),
);

/** Mã giảm giá không bắt buộc: vắng/null/rỗng → null; có thì ≤ 64 ký tự, bỏ khoảng trắng đầu/cuối. */
export const discountCodeSchema = z.pipe(
  z.nullish(z.string({ error: M.discount }).check(z.maxLength(L.discountCodeMax, M.discount))),
  z.transform((v) => {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
  }),
);

export const paymentMethodSchema = z.enum(CHECKOUT_PAYMENT_METHODS, { error: M.payment });

const idSchema = (message: string) =>
  z.string({ error: message }).check(z.trim(), z.minLength(1, message), z.maxLength(L.idMax, message));

export const cartVersionSchema = z
  .int({ error: M.cartVersion })
  .check(z.gte(1, M.cartVersion), z.lte(L.cartVersionMax, M.cartVersion));

/* ------------------------------------------------------------------------------------- wire (thân request backend) */

export const checkoutAddressSchema = z.strictObject(
  { province_code: provinceCodeSchema, ward_code: wardCodeSchema, line: addressLineSchema },
  { error: M.address },
);

export const checkoutContactSchema = z.strictObject(
  { name: contactNameSchema, phone: vnPhoneSchema, email: optionalEmailSchema },
  { error: M.contact },
);

/** POST /store/x/checkout/quote. */
export const checkoutQuoteRequestSchema = z.strictObject(
  {
    cart_id: idSchema(M.cartId),
    payment_method: paymentMethodSchema,
    address: checkoutAddressSchema,
    discount_code: discountCodeSchema,
  },
  { error: M.invalid },
);

/** POST /store/x/checkout/submit (header Idempotency-Key kiểm riêng). */
export const checkoutSubmitRequestSchema = z.strictObject(
  {
    cart_id: idSchema(M.cartId),
    cart_version: cartVersionSchema,
    quote_id: idSchema(M.quoteId),
    payment_method: paymentMethodSchema,
    contact: checkoutContactSchema,
    address: checkoutAddressSchema,
  },
  { error: M.invalid },
);

export type CheckoutQuoteRequest = z.output<typeof checkoutQuoteRequestSchema>;
export type CheckoutSubmitRequest = z.output<typeof checkoutSubmitRequestSchema>;

/* ------------------------------------------------------------------------- form (camelCase, client + Server Action) */

const addressFormShape = {
  provinceCode: provinceCodeSchema,
  wardCode: wardCodeSchema,
  line: addressLineSchema,
};
const contactFormShape = { name: contactNameSchema, phone: vnPhoneSchema, email: optionalEmailSchema };

export const checkoutAddressFormSchema = z.object(addressFormShape, { error: M.address });
export const checkoutContactFormSchema = z.object(contactFormShape, { error: M.contact });

/** Giá trị phẳng của form checkout (liên hệ + giao hàng) — kiểm khi bấm "Đặt hàng". */
export const checkoutFormSchema = z.object({ ...contactFormShape, ...addressFormShape });

/** Đầu vào Server Action `quoteCheckout`. */
export const checkoutQuoteInputSchema = z.object({
  paymentMethod: paymentMethodSchema,
  address: checkoutAddressFormSchema,
  discountCode: discountCodeSchema,
});

/** Phần form của đầu vào Server Action `submitCheckout` (khoá idempotency/mã báo giá do storefront kiểm riêng). */
export const checkoutSubmitInputSchema = z.object({
  cartVersion: cartVersionSchema,
  paymentMethod: paymentMethodSchema,
  contact: checkoutContactFormSchema,
  address: checkoutAddressFormSchema,
  discountCode: discountCodeSchema,
});

export type CheckoutFormValues = z.output<typeof checkoutFormSchema>;
export type CheckoutQuoteInput = z.output<typeof checkoutQuoteInputSchema>;
export type CheckoutSubmitInput = z.output<typeof checkoutSubmitInputSchema>;

/* ------------------------------------------------------------------------------------------- lỗi theo trường */

/** Ô của form checkout, theo thứ tự DOM (lỗi đầu tiên theo thứ tự này nhận focus). */
export const CHECKOUT_FORM_FIELDS = [
  "name",
  "phone",
  "email",
  "province",
  "ward",
  "line",
  "discount",
  "payment",
] as const;
export type CheckoutFormField = (typeof CHECKOUT_FORM_FIELDS)[number];

/** Khoá (wire hoặc form) → ô form. Cả nhóm `contact`/`address` thiếu → ô đầu tiên của nhóm. */
const FORM_FIELD_OF_KEY: Readonly<Record<string, CheckoutFormField>> = {
  name: "name",
  phone: "phone",
  email: "email",
  province_code: "province",
  provinceCode: "province",
  ward_code: "ward",
  wardCode: "ward",
  line: "line",
  discount_code: "discount",
  discountCode: "discount",
  payment_method: "payment",
  paymentMethod: "payment",
  contact: "name",
  address: "province",
};

/** Đường dẫn lỗi (mảng khoá hoặc chuỗi `a.b`) → ô form; không thuộc ô nào (vd `cart_id`, `Idempotency-Key`) → undefined. */
export function checkoutFormFieldOf(path: readonly PropertyKey[] | string): CheckoutFormField | undefined {
  const keys = typeof path === "string" ? path.split(".") : path.map(String);
  for (let i = keys.length - 1; i >= 0; i--) {
    const f = Object.hasOwn(FORM_FIELD_OF_KEY, keys[i]!) ? FORM_FIELD_OF_KEY[keys[i]!] : undefined;
    if (f !== undefined) return f;
  }
  return undefined;
}

export interface FieldIssue {
  /** Đường dẫn trường dạng `a.b` (wire), vd `contact.phone`; lỗi ở gốc → `body`. */
  field: string;
  message: string;
}

interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
}

/** Mọi lỗi của một lần parse → danh sách theo trường (mỗi trường một lỗi, giữ thứ tự schema). */
export function checkoutFieldIssues(error: { readonly issues: readonly IssueLike[] }): FieldIssue[] {
  const out: FieldIssue[] = [];
  const seen = new Set<string>();
  const push = (field: string, message: string) => {
    if (seen.has(field)) return;
    seen.add(field);
    out.push({ field, message });
  };
  for (const issue of error.issues) {
    const base = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys ?? []) push([...base, key].join("."), M.unknownKey);
      continue;
    }
    push(base.join(".") || "body", issue.message || M.invalid);
  }
  return out;
}

export type CheckoutParseResult<T> =
  { ok: true; data: T } | { ok: false; issues: [FieldIssue, ...FieldIssue[]] };

/** Parse thân request backend; lỗi → danh sách theo trường (route trả 422 VALIDATION). */
export function parseCheckoutRequest<S extends z.ZodMiniType>(
  schema: S,
  body: unknown,
): CheckoutParseResult<z.output<S>> {
  const r = schema.safeParse(body ?? {});
  if (r.success) return { ok: true, data: r.data as z.output<S> };
  const issues = checkoutFieldIssues(r.error);
  return {
    ok: false,
    issues:
      issues.length > 0 ? (issues as [FieldIssue, ...FieldIssue[]]) : [{ field: "body", message: M.invalid }],
  };
}

export type CheckoutFormErrors = Partial<Record<CheckoutFormField, string>>;

export type CheckoutFormParseResult<T> =
  | { ok: true; data: T }
  /** `field` vắng khi lỗi không thuộc ô nào của form (vd `cartVersion`). */
  | { ok: false; errors: CheckoutFormErrors; field: CheckoutFormField | undefined; message: string };

/**
 * Parse giá trị form / đầu vào Server Action (camelCase). Đầu vào không phải object (null, mảng, chuỗi…) được coi như
 * object rỗng — lỗi rơi vào từng ô còn thiếu, luôn có `field` để client gắn lỗi và đặt focus.
 */
export function parseCheckoutForm<S extends z.ZodMiniType>(
  schema: S,
  input: unknown,
): CheckoutFormParseResult<z.output<S>> {
  const value = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data as z.output<S> };
  const issues = checkoutFieldIssues(r.error);
  const errors: CheckoutFormErrors = {};
  for (const issue of issues) {
    const f = checkoutFormFieldOf(issue.field);
    if (f !== undefined && errors[f] === undefined) errors[f] = issue.message;
  }
  const field = CHECKOUT_FORM_FIELDS.find((f) => errors[f] !== undefined);
  const message = field !== undefined ? errors[field]! : (issues[0]?.message ?? M.invalid);
  return { ok: false, errors, field, message };
}
