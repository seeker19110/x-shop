import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { validateAddress, type AddressSnapshot } from "@x-shop/domain";
import {
  parseCheckoutRequest,
  type CheckoutQuoteRequest,
  type CheckoutSubmitRequest,
} from "@x-shop/domain/validation";
import type { z } from "zod";
import type { CartAccessContext } from "./cart";
import { clientIpOf } from "../security/config";
import { logServerError } from "../errors/error-handler";
import { CheckoutError, readCheckoutError, sendProblem } from "./errors";

/**
 * Lớp HTTP chung của /store/x/checkout/*: kiểm đầu vào ở server (đặc tả §9.1 "Validation ở server; lỗi có code ổn
 * định, thông báo tiếng Việt và trường gây lỗi"), ngữ cảnh quyền, ánh xạ lỗi → problem+json.
 */

type CheckoutSchema = Parameters<typeof parseCheckoutRequest>[0];
type CheckoutOutput<S extends CheckoutSchema> = z.output<S>;
export type { CheckoutQuoteRequest, CheckoutSubmitRequest };

/** Parse body bằng schema zod (route ngoài checkout); lỗi → 422 VALIDATION với `field` của lỗi đầu tiên. */
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
  throw new CheckoutError("VALIDATION", "Dữ liệu chưa hợp lệ", { field });
}

/**
 * Parse thân request checkout bằng schema DÙNG CHUNG với form storefront (`@x-shop/domain/validation`, FE-FORM-001).
 * Lỗi → 422 VALIDATION: `field`/`detail` của lỗi đầu tiên (hợp đồng cũ) + `errors[{param, reason}]` cho MỌI trường sai.
 */
export function parseCheckoutBody<S extends CheckoutSchema>(schema: S, body: unknown): CheckoutOutput<S> {
  const r = parseCheckoutRequest(schema, body);
  if (r.ok) return r.data;
  const [first] = r.issues;
  throw new CheckoutError("VALIDATION", first.message, {
    field: first.field,
    detail: { errors: r.issues.map((i) => ({ param: i.field, reason: i.message })) },
  });
}

/** Địa chỉ 2 cấp theo danh mục hiện hành (CHK03) → snapshot; lỗi gắn trường `address.*`. */
export function toAddressSnapshot(address: CheckoutQuoteRequest["address"]): AddressSnapshot {
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
  logServerError(req, "checkout", error);
  sendProblem(res, known ?? new CheckoutError("INTERNAL"));
}
