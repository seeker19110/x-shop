import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { normalizeVnPhone, validateAddress, type AddressSnapshot } from "@x-shop/domain";
import { z } from "zod";
import { PAYMENT_METHODS } from "../../modules/checkout/models/constants";
import type { CartAccessContext } from "./cart";
import { clientIpOf } from "../security/config";
import { CheckoutError, readCheckoutError, sendProblem } from "./errors";

/**
 * Lớp HTTP chung của /store/x/checkout/*: kiểm đầu vào ở server (đặc tả §9.1 "Validation ở server; lỗi có code ổn
 * định, thông báo tiếng Việt và trường gây lỗi"), ngữ cảnh quyền, ánh xạ lỗi → problem+json.
 */

const id = z.string().trim().min(1).max(100);
const addressSchema = z.strictObject({
  province_code: z.string().trim().min(1).max(10),
  ward_code: z.string().trim().min(1).max(10),
  line: z.string().max(500),
});

export const quoteBodySchema = z.strictObject({
  cart_id: id,
  payment_method: z.enum(PAYMENT_METHODS),
  address: addressSchema,
  discount_code: z.string().max(64).nullish(),
});

export const submitBodySchema = z.strictObject({
  cart_id: id,
  cart_version: z.number().int().min(1).max(1_000_000),
  quote_id: id,
  payment_method: z.enum(PAYMENT_METHODS),
  contact: z.strictObject({
    name: z.string().trim().min(1).max(100),
    phone: z.string().max(32),
    email: z
      .string()
      .trim()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
      .nullish(),
  }),
  address: addressSchema,
});

const FIELD_MESSAGES: Record<string, string> = {
  cart_id: "Thiếu mã giỏ hàng",
  cart_version: "Phiên bản giỏ không hợp lệ",
  quote_id: "Thiếu mã báo giá",
  payment_method: "Phương thức thanh toán không hợp lệ",
  discount_code: "Mã giảm giá không hợp lệ",
  "contact.name": "Vui lòng nhập họ tên",
  "contact.phone": "Số điện thoại không hợp lệ",
  "contact.email": "Email không hợp lệ",
  "address.province_code": "Vui lòng chọn tỉnh/thành phố",
  "address.ward_code": "Vui lòng chọn phường/xã",
  "address.line": "Vui lòng nhập số nhà, tên đường",
};

/** Parse body bằng schema; lỗi → 422 VALIDATION với `field` của lỗi đầu tiên. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  if (issue?.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "";
    const field = [...issue.path.map(String), key].filter(Boolean).join(".");
    throw new CheckoutError("VALIDATION", "Có trường không được chấp nhận trong yêu cầu", { field });
  }
  const field = (issue?.path ?? []).map(String).join(".") || "body";
  throw new CheckoutError("VALIDATION", FIELD_MESSAGES[field] ?? "Dữ liệu chưa hợp lệ", { field });
}

/** Địa chỉ 2 cấp theo danh mục hiện hành (CHK03) → snapshot; lỗi gắn trường `address.*`. */
export function toAddressSnapshot(address: z.output<typeof addressSchema>): AddressSnapshot {
  const r = validateAddress({
    provinceCode: address.province_code,
    wardCode: address.ward_code,
    line: address.line,
  });
  if (!r.ok) {
    const field = r.field === "address_line" ? "address.line" : `address.${r.field ?? "province_code"}`;
    throw new CheckoutError("VALIDATION", r.message, { field });
  }
  return r.value;
}

export function normalizeContact(contact: z.output<typeof submitBodySchema>["contact"]) {
  const phone = normalizeVnPhone(contact.phone);
  if (!phone.ok) throw new CheckoutError("VALIDATION", phone.message, { field: "contact.phone" });
  return {
    name: contact.name.normalize("NFC").replace(/\s+/g, " "),
    phone: phone.value,
    email: contact.email ? contact.email.toLowerCase() : null,
  };
}

/** Ngữ cảnh quyền: kênh bán của publishable key + customer đã xác thực (không bao giờ lấy từ body). */
export function accessContext(req: MedusaStoreRequest): CartAccessContext {
  const actor = req.auth_context;
  return {
    salesChannelIds: req.publishable_key_context?.sales_channel_ids ?? [],
    actorId: actor && actor.actor_type === "customer" && actor.actor_id ? actor.actor_id : null,
  };
}

/**
 * IP khách (vnp_IpAddr, rate limit đơn sau mua): theo `XS_TRUSTED_PROXIES` — mặc định không tin X-Forwarded-For
 * (lib/security/client-ip.ts); IPv4 thuần nếu là địa chỉ ánh xạ IPv6.
 */
export function clientIp(req: MedusaStoreRequest): string {
  return clientIpOf(req).ip ?? "127.0.0.1";
}

/** Lỗi nghiệp vụ → problem+json; lỗi khác → log + 500 INTERNAL (không lộ chi tiết nội bộ). */
export function handleRouteError(req: MedusaStoreRequest, res: MedusaResponse, error: unknown): void {
  const known = readCheckoutError(error);
  if (known && known.code !== "INTERNAL") {
    sendProblem(res, known);
    return;
  }
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  logger.error(
    `[checkout] ${req.method} ${req.path}: ${error instanceof Error ? error.stack : JSON.stringify(error)}`,
  );
  sendProblem(res, known ?? new CheckoutError("INTERNAL"));
}
