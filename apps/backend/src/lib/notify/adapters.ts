import { maskEmail, maskPhone } from "@x-shop/domain";
import type { NotifyChannel } from "../../modules/notify/models/outbound-message";
import type { TemplateName } from "./templates";

/**
 * Giao diện gửi email/SMS giao dịch (đặc tả §9.3). Adapter thật (SMTP/ESP, SMS brandname) gắn sau bằng cách cài
 * `NotificationAdapter` khác và trả từ `getNotificationAdapter()` theo cấu hình — cần khoá dịch vụ của chủ dự án.
 * `messageKey` là khóa idempotency: adapter thật nên chuyển nó cho nhà cung cấp nếu họ hỗ trợ.
 */
export interface OutgoingMessage {
  messageKey: string;
  template: TemplateName;
  channel: NotifyChannel;
  /** Địa chỉ nhận đầy đủ — chỉ dùng để gửi, KHÔNG ghi log. */
  to: string;
  subject: string;
  text: string;
  sms: string;
}

export interface NotifyLogger {
  info(message: string): void;
}

export interface NotificationAdapter {
  readonly name: string;
  /** false = không gửi thật (dev/P0) → outbound_message.live = false. */
  readonly live: boolean;
  send(
    message: OutgoingMessage,
    ctx: { logger: NotifyLogger },
  ): Promise<{ providerMessageId: string | null }>;
}

export function maskRecipient(channel: NotifyChannel, to: string): string {
  return channel === "email" ? maskEmail(to) : maskPhone(to);
}

/**
 * Adapter mặc định: KHÔNG gửi thật, chỉ ghi một dòng log đã che PII (không tên, không nội dung, không link — link tra cứu
 * chứa token).
 */
export class LogNotificationAdapter implements NotificationAdapter {
  readonly name = "log";
  readonly live = false;
  async send(message: OutgoingMessage, ctx: { logger: NotifyLogger }) {
    ctx.logger.info(
      `[notify:log] ${message.template} kênh=${message.channel} tới=${maskRecipient(message.channel, message.to)} ` +
        `key=${message.messageKey} (không gửi thật)`,
    );
    return { providerMessageId: null };
  }
}

let override: NotificationAdapter | null = null;
const defaultAdapter = new LogNotificationAdapter();

/** Adapter theo cấu hình — hiện chỉ có `log` (chưa có khoá email/SMS thật). */
export function getNotificationAdapter(): NotificationAdapter {
  return override ?? defaultAdapter;
}

/** Chỉ cho test: thay adapter (null = mặc định). */
export function setNotificationAdapterForTest(adapter: NotificationAdapter | null): void {
  override = adapter;
}
