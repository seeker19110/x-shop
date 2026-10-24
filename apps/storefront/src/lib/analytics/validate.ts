import { z } from "zod";
import {
  EVENT_NAMES,
  findPii,
  ID_RE,
  MAX_ITEMS,
  ORDER_EVENTS,
  PAYMENT_TYPES,
  SCHEMA_VERSION,
  type AnalyticsEvent,
} from "./schema";

/** Chỉ dùng ở server (route `/api/analytics`): kéo zod, không import từ client component. */

const id = z.string().regex(ID_RE);
const money = z.number().int().min(0).max(2_147_483_647);

const item = z.object({
  item_id: id,
  sku: id.optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  price: money.optional(),
});

/** Object zod mặc định LOẠI trường lạ (strip): chỉ các khóa dưới đây còn lại sau parse. */
const eventSchema = z
  .object({
    v: z.literal(SCHEMA_VERSION),
    event: z.enum(EVENT_NAMES),
    currency: z.literal("VND"),
    value: money.optional(),
    items: z.array(item).max(MAX_ITEMS).optional(),
    order_id: id.optional(),
    list_id: id.optional(),
    index: z.number().int().min(0).max(10_000).optional(),
    payment_type: z.enum(PAYMENT_TYPES).optional(),
  })
  .superRefine((e, ctx) => {
    if ((ORDER_EVENTS as readonly string[]).includes(e.event)) {
      if (e.order_id === undefined) ctx.addIssue({ code: "custom", path: ["order_id"], message: "bắt buộc" });
      if (e.value === undefined) ctx.addIssue({ code: "custom", path: ["value"], message: "bắt buộc" });
    }
  });

export type ValidateResult =
  { ok: true; event: AnalyticsEvent } | { ok: false; reason: "pii" | "schema"; path?: string };

/**
 * Thứ tự: (1) quét PII trên payload THÔ — kể cả trường lạ sẽ bị loại — vì "loại" không đủ nếu dữ liệu đã tới server;
 * (2) validate schema, loại trường lạ.
 */
export function validateEvent(raw: unknown): ValidateResult {
  const pii = findPii(raw);
  if (pii) return { ok: false, reason: "pii", path: pii };
  const r = eventSchema.safeParse(raw);
  if (!r.success) return { ok: false, reason: "schema", path: r.error.issues[0]?.path.join(".") };
  return { ok: true, event: r.data as AnalyticsEvent };
}
