import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { OutboxClaim } from "../../modules/checkout/service";
import { NOTIFY_MODULE } from "../../modules/notify";
import type NotifyModuleService from "../../modules/notify/service";
import type { NotifyChannel } from "../../modules/notify/models/outbound-message";
import { parseEnv } from "../env";
import { issueOrderToken } from "../orders/access";
import { getNotificationAdapter, maskRecipient } from "./adapters";
import { renderTemplate, type TemplateData, type TemplateName } from "./templates";
import { isNonEmpty } from "@x-shop/domain";

/**
 * Gửi thông báo giao dịch từ outbox (T-029, SPEC-payment S-109, AT18): mỗi sự kiện outbox → tối đa một thông báo với
 * message key `notify:<event_key>:<kênh>`. Lỗi gửi ném ra để outbox-dispatch retry lũy thừa có jitter (đơn không bị đụng
 * tới); lỗi vĩnh viễn của adapter (4xx không phải 408/429) hoặc quá trần → ngoại lệ `notification_failed`. Chỉ đọc trạng thái đơn đã finalization — sự kiện native không gửi gì (AT34).
 */
export const NOTIFICATION_EVENT_TYPES = [
  "order.placed_pending",
  "order.confirmed",
  "order.lookup_link",
  "shipment.shipped",
] as const;

export function isNotificationEvent(type: string): boolean {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Che email/SĐT và token liên kết (adapter có thể nhắc lại nội dung thư trong lỗi — T-149) lọt vào thông điệp lỗi trước
 * khi ghi DB/log. Token: tham số `token=` và mọi chuỗi dạng token ký HMAC (`base64url.base64url`).
 */
export function scrubPii(s: string): string {
  return s
    .replace(/([?&]token=)[^\s&"'<>]+/gi, "$1***")
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "***")
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, "***@***")
    .replace(/\+?\d[\d\s.-]{6,}\d/g, "***")
    .slice(0, 300);
}

interface Contact {
  name?: string;
  phone?: string;
  email?: string | null;
}

export type NotifyOutcome = "sent" | "duplicate" | "skipped";

let cachedStorefrontUrl: string | null = null;

/** Gốc URL storefront (STOREFRONT_URL, đã kiểm lúc khởi động; dev/test vắng → DEV_STOREFRONT_URL). */
function storefrontUrl(): string {
  if (isNonEmpty(cachedStorefrontUrl)) return cachedStorefrontUrl;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[notify] cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cachedStorefrontUrl = parsed.env.storefrontUrl;
  return cachedStorefrontUrl;
}

/** Liên kết tra cứu đơn (trang storefront `/tra-cuu-don/xac-thuc`, POST01) cho token `link`. */
export function orderLookupLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/tra-cuu-don/xac-thuc?token=${encodeURIComponent(token)}`;
}

export async function sendNotification(
  container: MedusaContainer,
  input: {
    messageKey: string;
    aggregateId: string;
    template: TemplateName;
    channel: NotifyChannel;
    to: string;
    data: TemplateData;
  },
): Promise<NotifyOutcome> {
  const adapter = getNotificationAdapter();
  const notify = container.resolve<NotifyModuleService>(NOTIFY_MODULE);
  const rendered = renderTemplate(input.template, input.data);
  const id = await notify.reserve({
    message_key: input.messageKey,
    aggregate_id: input.aggregateId,
    template: input.template,
    channel: input.channel,
    recipient_masked: maskRecipient(input.channel, input.to),
    adapter: adapter.name,
    live: adapter.live,
  });
  if (!isNonEmpty(id)) return "duplicate";
  try {
    const r = await adapter.send(
      {
        messageKey: input.messageKey,
        template: input.template,
        channel: input.channel,
        to: input.to,
        ...rendered,
      },
      { logger: container.resolve(ContainerRegistrationKeys.LOGGER) },
    );
    await notify.markSent(id, r.providerMessageId);
    return "sent";
  } catch (e) {
    const reason = scrubPii(e instanceof Error ? `${e.name}: ${e.message}` : "lỗi không rõ");
    await notify.markFailed(id, reason);
    // `cause` giữ mã gốc của adapter (status 4xx vĩnh viễn, `retryAfterMs`) cho outbox phân loại (T-093); thông điệp
    // ghi DB/log vẫn chỉ là bản đã che PII.
    throw new Error(`gửi ${input.template} qua ${input.channel} lỗi — ${reason}`, { cause: e });
  }
}

/** Bộ xử lý outbox cho sự kiện thông báo. Không có gì để gửi (đơn online chưa thu, đơn hủy…) → coi như xong. */
export async function notificationHandler(container: MedusaContainer, event: OutboxClaim): Promise<void> {
  const orderId = String(event.payload.order_id ?? event.aggregate_id);
  const [fin] = await container.resolve<CheckoutModuleService>(CHECKOUT_MODULE).listOrderFinances({
    order_id: orderId,
  });
  if (!fin) throw new Error(`không thấy đơn ${orderId}`);
  const state = String(fin.state);
  if (state === "preparing") throw new Error("đơn chưa finalization"); // AT34 — chờ, không gửi sai
  let template: TemplateName;
  const extra: Partial<TemplateData> = {};
  switch (event.type) {
    case "order.placed_pending":
      if (fin.payment_method !== "cod" || state === "cancelled") return;
      template = "order.placed";
      break;
    case "order.confirmed":
      if (state !== "confirmed" && state !== "completed") return;
      template = "order.confirmed";
      break;
    case "order.lookup_link":
      // T-149 (D-089): token một lần (15 phút, tính từ LÚC GỬI) phát hành tại đây, chỉ nằm trong thư — outbox chỉ có ID.
      // Retry phát token mới: token cũ (thư lỗi có thể đã tới) vẫn chỉ mở đúng đơn này, một lần, tới khi hết hạn —
      // không rộng hơn token mới (cùng loại `link`, cùng đơn, cùng người nhận trên đơn).
      template = "order.lookup_link";
      extra.link = orderLookupLink(storefrontUrl(), issueOrderToken("link", orderId).token);
      break;
    case "shipment.shipped":
      template = "shipment.shipped";
      extra.tracking_code =
        typeof event.payload.provider_order_code === "string" ? event.payload.provider_order_code : null;
      break;
    default:
      return;
  }
  const contact = (fin.contact ?? {}) as Contact;
  // Email/điện thoại rỗng coi như không có (chuyển kênh kế tiếp), giữ hành vi cũ.
  const channel: NotifyChannel | null = isNonEmpty(contact.email)
    ? "email"
    : isNonEmpty(contact.phone)
      ? "sms"
      : null;
  if (!channel) return;
  const to = channel === "email" ? String(contact.email) : String(contact.phone).replace(/\D/g, "");
  await sendNotification(container, {
    messageKey: `notify:${event.event_key}:${channel}`,
    aggregateId: orderId,
    template,
    channel,
    to,
    data: {
      name: contact.name ?? "bạn",
      display_ref: fin.display_ref,
      total: Number(fin.total),
      ...extra,
    },
  });
}
