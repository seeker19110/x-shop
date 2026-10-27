import { z } from "zod";

/**
 * Schema payload sự kiện outbox, kiểm khi worker NHẬN (T-093 — BE-JOB-007). Payload chỉ chứa ID + tham số tối thiểu:
 *  - mọi payload: object phẳng, giá trị nguyên thuỷ (chuỗi ≤ 2000 ký tự, số hữu hạn, boolean, null) — không object đã
 *    serialize (dễ lệch phiên bản), ≤ 32 khoá; tên khoá không gợi bí mật (password/secret/token/otp/api key/cookie/thẻ);
 *  - loại đã biết: thêm trường bắt buộc mà bộ xử lý cần (`order_id`…), tiền là số nguyên an toàn ≥ 0.
 * Sai → `{ ok: false, reason }`; dispatcher chuyển `dead` ngay kèm lý do (không ném làm sập lượt). `reason` chỉ gồm
 * đường dẫn trường + mã lỗi zod — KHÔNG chứa giá trị (có thể là PII).
 */

const MAX_KEYS = 32;
const MAX_STRING = 2000;

const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "token",
  "otp",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "cvv",
  "pan",
  "cardnumber",
]);

/**
 * Tên khoá gợi bí mật (BE-JOB-007): tách theo `_`/`-`/`.`/camelCase rồi so từng từ (và cặp từ liền kề: `api_key`,
 * `card_number`) — `accessToken`, `vnp_secret`, `api-key` bị chặn; `company`, `passenger_count` không.
 */
export function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter((w) => w !== "");
  return words.some((w, i) => SECRET_WORDS.has(w) || SECRET_WORDS.has(w + (words[i + 1] ?? "")));
}

const primitive = z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean(), z.null()]);

const flatPayload = z
  .record(z.string().min(1).max(64), primitive)
  .refine((p) => Object.keys(p).length <= MAX_KEYS, { message: "quá nhiều khoá" })
  .superRefine((p, ctx) => {
    for (const k of Object.keys(p)) {
      if (isSecretKey(k)) {
        ctx.addIssue({ code: "custom", path: [k], message: "khoá gợi bí mật" });
      }
    }
  });

const id = z.string().min(1).max(100);
const orderId = z.string().regex(/^order_[0-9A-Za-z]{1,64}$/);
const money = z.number().int().nonnegative().refine(Number.isSafeInteger);

/** Trường bộ xử lý cần theo loại (khoá khác được phép nếu qua `flatPayload`). */
const BY_TYPE: Record<string, z.ZodType> = {
  "order.placed_pending": z.looseObject({
    order_id: orderId,
    display_ref: id.optional(),
    payment_method: z.enum(["cod", "vnpay"]).optional(),
  }),
  "order.confirmed": z.looseObject({ order_id: orderId, display_ref: id.optional() }),
  // Bộ xử lý (lib/notify) gửi `link` dựng sẵn — URL http(s) tuyệt đối.
  "order.lookup_link": z.looseObject({
    order_id: orderId,
    link: z
      .string()
      .max(MAX_STRING)
      .regex(/^https?:\/\/[^\s]+$/),
  }),
  "shipment.shipped": z.looseObject({
    order_id: orderId,
    shipment_id: id.optional(),
    provider_order_code: id.nullable().optional(),
  }),
  "payment.native_sync": z.looseObject({ order_id: orderId, amount: money.optional() }),
  "order.cancelled": z.looseObject({
    order_id: orderId,
    reason: id.optional(),
    refund_amount: money.optional(),
  }),
};

export const OUTBOX_PAYLOAD_TYPES = Object.keys(BY_TYPE);

export type PayloadCheck = { ok: true } | { ok: false; reason: string };

function describe(issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>): string {
  const parts = issues.slice(0, 5).map((i) => {
    const path = i.path.map((p) => (typeof p === "symbol" ? "?" : String(p).slice(0, 64))).join(".");
    return `${path === "" ? "(gốc)" : path}:${i.code}`;
  });
  return `payload không hợp lệ — ${parts.join(", ")}${issues.length > 5 ? ", …" : ""}`;
}

/** Kiểm payload của sự kiện `type`. Loại chưa khai schema riêng chỉ qua kiểm chung (phẳng, không khoá bí mật). */
export function validateOutboxPayload(type: string, payload: unknown): PayloadCheck {
  const flat = flatPayload.safeParse(payload);
  if (!flat.success) return { ok: false, reason: describe(flat.error.issues) };
  const schema = BY_TYPE[type];
  if (!schema) return { ok: true };
  const typed = schema.safeParse(payload);
  return typed.success ? { ok: true } : { ok: false, reason: describe(typed.error.issues) };
}
