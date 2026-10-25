import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId, MedusaService } from "@medusajs/framework/utils";
import { OutboundMessage, type NotifyChannel } from "./models/outbound-message";

interface BaseRepositoryLike {
  getFreshManager(): SqlEntityManager;
}

/** Service của module `notify`: giữ chỗ/đánh dấu thông báo theo message key bằng câu lệnh nguyên tử. */
class NotifyModuleService extends MedusaService({ OutboundMessage }) {
  protected readonly repo_: BaseRepositoryLike;

  constructor(container: { baseRepository: BaseRepositoryLike }, ...rest: unknown[]) {
    super(container, ...rest);
    this.repo_ = container.baseRepository;
  }

  private async exec(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    return (await this.repo_.getFreshManager().execute(sql, params, "all")) as Array<Record<string, unknown>>;
  }

  /**
   * Giữ chỗ gửi một thông báo: lần đầu → tạo dòng `sending`; đã có mà chưa `sent` (lần trước lỗi) → tăng attempts, gửi
   * lại cùng key; đã `sent` → null (KHÔNG gửi lần nữa — AT18 "gửi lại không trùng message key").
   */
  async reserve(input: {
    message_key: string;
    aggregate_id: string;
    template: string;
    channel: NotifyChannel;
    recipient_masked: string;
    adapter: string;
    live: boolean;
  }): Promise<string | null> {
    const rows = await this.exec(
      `INSERT INTO outbound_message
         (id, message_key, aggregate_id, template, channel, recipient_masked, adapter, live, state, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1)
       ON CONFLICT (message_key) DO UPDATE SET attempts = outbound_message.attempts + 1, state = 'sending',
         adapter = EXCLUDED.adapter, live = EXCLUDED.live, updated_at = now()
       WHERE outbound_message.state <> 'sent'
       RETURNING id`,
      [
        generateEntityId(undefined, "omsg"),
        input.message_key,
        input.aggregate_id,
        input.template,
        input.channel,
        input.recipient_masked,
        input.adapter,
        input.live,
      ],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  async markSent(id: string, providerMessageId: string | null): Promise<void> {
    await this.exec(
      `UPDATE outbound_message SET state = 'sent', provider_message_id = ?, last_error = NULL, sent_at = now(),
         updated_at = now()
       WHERE id = ?`,
      [providerMessageId, id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.exec(
      `UPDATE outbound_message SET state = 'failed', last_error = ?, updated_at = now() WHERE id = ? AND state = 'sending'`,
      [error.slice(0, 500), id],
    );
  }
}

export default NotifyModuleService;
