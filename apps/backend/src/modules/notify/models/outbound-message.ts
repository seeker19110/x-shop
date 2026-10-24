import { model } from "@medusajs/framework/utils";

export const NOTIFY_CHANNELS = ["email", "sms"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];
export const OUTBOUND_STATES = ["sending", "sent", "failed"] as const;

/**
 * Thông báo giao dịch đã/đang gửi (đặc tả §9.3, SPEC-payment S-109). `message_key` UNIQUE — chống gửi lặp khi outbox
 * retry hay dispatcher chạy lại: dòng đã `sent` thì không gửi nữa. `live = false` khi adapter không gửi thật (adapter
 * `log` ở dev/P0). KHÔNG lưu nội dung thư/SMS hay địa chỉ nhận đầy đủ — chỉ bản đã che (`recipient_masked`).
 */
export const OutboundMessage = model
  .define("outbound_message", {
    id: model.id({ prefix: "omsg" }).primaryKey(),
    message_key: model.text(),
    aggregate_id: model.text(),
    template: model.text(),
    channel: model.enum([...NOTIFY_CHANNELS]),
    recipient_masked: model.text(),
    adapter: model.text(),
    live: model.boolean().default(false),
    state: model.enum([...OUTBOUND_STATES]).default("sending"),
    attempts: model.number().default(1),
    provider_message_id: model.text().nullable(),
    last_error: model.text().nullable(),
    sent_at: model.dateTime().nullable(),
  })
  .indexes([
    { name: "IDX_outbound_message_key_unique", on: ["message_key"], unique: true, where: null },
    { name: "IDX_outbound_message_aggregate", on: ["aggregate_id"], where: null },
  ])
  .checks([{ name: "outbound_message_attempts_pos", expression: (c) => `${c.attempts} >= 1` }]);
