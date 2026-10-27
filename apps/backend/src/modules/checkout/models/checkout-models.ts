import { model } from "@medusajs/framework/utils";
import {
  ATTEMPT_STATES,
  COUPON_USAGE_STATES,
  JOB_BREAKER_STATES,
  JOB_BREAKER_TRIP_REASONS,
  LEDGER_KINDS,
  OPS_EXCEPTION_KINDS,
  OPS_EXCEPTION_STATES,
  OPS_PRIORITIES,
  ORDER_STATES,
  OUTBOX_STATES,
  PAYMENT_METHODS,
  PAYMENT_STATES,
} from "./constants";

/*
 * Model DSL của module `checkout` (docs/design/checkout-flow.md §2). Ràng buộc nghiệp vụ (UNIQUE/partial UNIQUE/CHECK)
 * thực thi ở Postgres (BASE-DATA-010) — khai báo ở đây để snapshot/ORM biết, và viết tường minh trong migration.
 *
 * Tiền: số nguyên VND. DSL `model.number()` ánh xạ cột `integer`; migration dùng `bigint` cho mọi cột tiền rồi ép kiểu
 * khi đọc (service) — xem Migration20261024180000. Không dùng float/numeric tự do.
 * Index khai `where: null` = không giới hạn theo `deleted_at` (ràng buộc giữ cả với bản ghi đã xoá mềm).
 */

/**
 * Báo giá do server tính (S-001, CHK04) — khách xác nhận đúng bản này rồi submit kèm `quote_id`. Bất biến sau khi tạo;
 * hết hạn sau 10 phút (`expires_at`).
 */
export const CheckoutQuote = model
  .define("checkout_quote", {
    id: model.id({ prefix: "cqt" }).primaryKey(),
    cart_id: model.text(),
    cart_version: model.number(),
    payment_method: model.enum([...PAYMENT_METHODS]),
    discount_code: model.text().nullable(),
    /** AddressSnapshot của domain (tên tỉnh/xã tại thời điểm báo giá). */
    address: model.json(),
    /** QuoteBreakdown của domain (`computeQuote`). */
    breakdown: model.json(),
    /**
     * Báo phí của hãng lúc quote (`ShippingFeeSnapshot` của domain: phí, đầu vào định phí, thời điểm/hạn) — submit dùng
     * lại khi còn hạn và đầu vào không đổi (T-153). null = quote tạo trước T-153 → submit hỏi lại hãng.
     */
    shipping: model.json().nullable(),
    total: model.number(),
    expires_at: model.dateTime(),
  })
  .indexes([{ name: "IDX_checkout_quote_cart_id", on: ["cart_id"], where: null }])
  .checks([
    { name: "checkout_quote_total_nonneg", expression: (c) => `${c.total} >= 0` },
    { name: "checkout_quote_cart_version_pos", expression: (c) => `${c.cart_version} >= 1` },
  ]);

/**
 * Phiên bản giỏ (DATA02). Medusa không có version cho cart; module giữ một dòng mỗi giỏ: `fingerprint` = hash nội dung
 * giỏ (dòng, biến thể, số lượng, region, tiền tệ, kênh bán) lần cuối được quan sát dưới khóa giỏ. Nội dung đổi →
 * `version` tăng. Phiên bản đã dùng cho đơn được đóng băng (`frozen_by_attempt`) — submit lại cùng phiên bản trả
 * attempt đã có.
 */
export const CartVersion = model
  .define("cart_version", {
    id: model.id({ prefix: "cver" }).primaryKey(),
    cart_id: model.text(),
    version: model.number(),
    fingerprint: model.text(),
    frozen_by_attempt: model.text().nullable(),
  })
  .indexes([{ name: "IDX_cart_version_cart_id_unique", on: ["cart_id"], unique: true, where: null }])
  .checks([{ name: "cart_version_version_pos", expression: (c) => `${c.version} >= 1` }]);

/**
 * Một lần submit checkout (đặc tả §6.2 bước 2, S-003). Ràng buộc ở DB:
 * - UNIQUE(idempotency_scope, idempotency_key) — cùng key trong cùng phạm vi chỉ một attempt (DATA01);
 * - UNIQUE(cart_id, cart_version) WHERE state IN (preparing, ready) — một checkout hoạt động cho một phiên bản giỏ
 *   (DATA02); attempt failed/compensated nhả chỗ để khách checkout lại sau khi xác nhận quote mới.
 */
export const CheckoutAttempt = model
  .define("checkout_attempt", {
    id: model.id({ prefix: "chk" }).primaryKey(),
    cart_id: model.text(),
    cart_version: model.number(),
    idempotency_scope: model.text(),
    idempotency_key: model.text(),
    payload_hash: model.text(),
    quote_id: model.text(),
    state: model.enum([...ATTEMPT_STATES]).default("preparing"),
    order_id: model.text().nullable(),
    /** QuoteBreakdown tính lại lúc submit (snapshot đã dùng để tạo đơn). */
    quote: model.json().nullable(),
    payment_method: model.enum([...PAYMENT_METHODS]),
    hold_expires_at: model.dateTime().nullable(),
    error_code: model.text().nullable(),
    error_detail: model.json().nullable(),
    lease_until: model.dateTime(),
  })
  .indexes([
    {
      name: "IDX_checkout_attempt_idempotency_unique",
      on: ["idempotency_scope", "idempotency_key"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_checkout_attempt_cart_version_active_unique",
      on: ["cart_id", "cart_version"],
      unique: true,
      where: "state IN ('preparing', 'ready')",
    },
    { name: "IDX_checkout_attempt_state_lease", on: ["state", "lease_until"], where: null },
  ])
  .checks([{ name: "checkout_attempt_cart_version_pos", expression: (c) => `${c.cart_version} >= 1` }]);

/**
 * Trạng thái thương mại + snapshot tiền của một order native (đặc tả §6.1, DATA05). Snapshot giá/quote/địa chỉ/liên hệ
 * bất biến sau khi tạo; `version` dùng cho cập nhật lạc quan khi chuyển trạng thái.
 */
export const OrderFinance = model
  .define("order_finance", {
    id: model.id({ prefix: "ofin" }).primaryKey(),
    order_id: model.text(),
    display_ref: model.text(),
    checkout_attempt_id: model.text(),
    cart_id: model.text(),
    state: model.enum([...ORDER_STATES]),
    total: model.number(),
    payment_method: model.enum([...PAYMENT_METHODS]),
    hold_expires_at: model.dateTime().nullable(),
    cod_confirm_by: model.dateTime().nullable(),
    policy_version: model.text(),
    quote: model.json(),
    address: model.json(),
    contact: model.json(),
    version: model.number().default(1),
  })
  .indexes([
    { name: "IDX_order_finance_order_id_unique", on: ["order_id"], unique: true, where: null },
    { name: "IDX_order_finance_display_ref_unique", on: ["display_ref"], unique: true, where: null },
    { name: "IDX_order_finance_state_hold", on: ["state", "hold_expires_at"], where: null },
  ])
  .checks([
    { name: "order_finance_total_nonneg", expression: (c) => `${c.total} >= 0` },
    { name: "order_finance_version_pos", expression: (c) => `${c.version} >= 1` },
  ]);

/**
 * Một lần thanh toán với provider (đặc tả §6.2 bước 5, §9.2). `txn_ref` là reference ổn định gửi provider (UNIQUE);
 * mỗi đơn tối đa MỘT attempt hoạt động (created/pending/unknown) — partial UNIQUE(order_id).
 */
export const PaymentAttempt = model
  .define("payment_attempt", {
    id: model.id({ prefix: "payatt" }).primaryKey(),
    order_id: model.text(),
    provider: model.text(),
    txn_ref: model.text(),
    amount: model.number(),
    state: model.enum([...PAYMENT_STATES]).default("created"),
    payment_url: model.text().nullable(),
    expires_at: model.dateTime(),
    provider_txn_no: model.text().nullable(),
  })
  .indexes([
    { name: "IDX_payment_attempt_txn_ref_unique", on: ["txn_ref"], unique: true, where: null },
    {
      name: "IDX_payment_attempt_order_active_unique",
      on: ["order_id"],
      unique: true,
      where: "state IN ('created', 'pending', 'unknown')",
    },
    // T-074: trang đơn đọc mọi lượt thanh toán của đơn (index trên chỉ phủ lượt đang mở) — docs/db/explain/.
    { name: "IDX_payment_attempt_order_id", on: ["order_id"], where: null },
  ])
  .checks([{ name: "payment_attempt_amount_pos", expression: (c) => `${c.amount} > 0` }]);

/**
 * Sổ cái tiền đã xác minh (đặc tả §6.1): mỗi khoản thu/hoàn là MỘT dòng, không ghi đè. UNIQUE(provider,
 * provider_txn_id, kind) chặn ghi trùng khoản thu khi IPN lặp (AT06); amount > 0.
 */
export const PaymentLedger = model
  .define("payment_ledger", {
    id: model.id({ prefix: "pled" }).primaryKey(),
    order_id: model.text(),
    kind: model.enum([...LEDGER_KINDS]),
    amount: model.number(),
    provider: model.text(),
    provider_txn_id: model.text(),
    refund_id: model.text().nullable(),
    state: model.text(),
  })
  .indexes([
    {
      name: "IDX_payment_ledger_provider_txn_kind_unique",
      on: ["provider", "provider_txn_id", "kind"],
      unique: true,
      where: null,
    },
    { name: "IDX_payment_ledger_order_id", on: ["order_id"], where: null },
  ])
  .checks([{ name: "payment_ledger_amount_pos", expression: (c) => `${c.amount} > 0` }]);

/** Webhook/IPN đã nhận — lưu TRƯỚC khi xử lý, khử trùng theo (provider, event_key) (đặc tả §8 WebhookInbox). */
export const WebhookInbox = model
  .define("webhook_inbox", {
    id: model.id({ prefix: "whin" }).primaryKey(),
    provider: model.text(),
    event_key: model.text(),
    /** `ipn` | `query` — nguồn của thông báo (CHECK `webhook_inbox_source_check`, T-101). */
    source: model.text().default("ipn"),
    /** Payload đã lọc PII. */
    payload: model.json(),
    payload_hash: model.text(),
    verified: model.boolean().default(false),
    result: model.json().nullable(),
    processed_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: "IDX_webhook_inbox_provider_event_unique",
      on: ["provider", "event_key"],
      unique: true,
      where: null,
    },
  ]);

/** Sự kiện bền vững gửi sau commit (DATA06): email/SMS/subscriber đọc từ đây, retry theo `next_attempt_at`. */
export const OutboxEvent = model
  .define("outbox_event", {
    id: model.id({ prefix: "obx" }).primaryKey(),
    event_key: model.text(),
    aggregate_id: model.text(),
    type: model.text(),
    payload: model.json(),
    state: model.enum([...OUTBOX_STATES]).default("pending"),
    attempts: model.number().default(0),
    next_attempt_at: model.dateTime(),
    last_error: model.text().nullable(),
  })
  .indexes([
    { name: "IDX_outbox_event_event_key_unique", on: ["event_key"], unique: true, where: null },
    { name: "IDX_outbox_event_state_next", on: ["state", "next_attempt_at"], where: null },
    // T-074: dòng thời gian của trang đơn đọc sự kiện theo đơn — docs/db/explain/order-view-outbox.txt.
    { name: "IDX_outbox_event_aggregate_id", on: ["aggregate_id"], where: null },
  ])
  .checks([{ name: "outbox_event_attempts_nonneg", expression: (c) => `${c.attempts} >= 0` }]);

/** Ngoại lệ vận hành có người phụ trách và hạn xử lý (đặc tả §5.5, §6.2). `dedupe_key` chống mở trùng. */
export const OpsException = model
  .define("ops_exception", {
    id: model.id({ prefix: "opx" }).primaryKey(),
    kind: model.enum([...OPS_EXCEPTION_KINDS]),
    dedupe_key: model.text().nullable(),
    order_id: model.text().nullable(),
    amount: model.number().nullable(),
    state: model.enum([...OPS_EXCEPTION_STATES]).default("open"),
    owner: model.text().nullable(),
    priority: model.enum([...OPS_PRIORITIES]).default("normal"),
    due_at: model.dateTime().nullable(),
    detail: model.json().nullable(),
  })
  .indexes([
    {
      name: "IDX_ops_exception_dedupe_unique",
      on: ["dedupe_key"],
      unique: true,
      where: "dedupe_key IS NOT NULL",
    },
    { name: "IDX_ops_exception_state_due", on: ["state", "due_at"], where: null },
    // T-074: trang đơn/hủy đơn đọc ngoại lệ theo đơn — docs/db/explain/order-view-ops-exceptions.txt.
    { name: "IDX_ops_exception_order_id", on: ["order_id"], where: null },
  ])
  .checks([
    {
      name: "ops_exception_amount_nonneg",
      expression: (c) => `${c.amount} IS NULL OR ${c.amount} >= 0`,
    },
  ]);

/**
 * Lượt dùng mã giảm (AT33). Giữ (`held`) dưới khóa `promotion:<code>` lúc submit — trước khi có order — nên khóa tự
 * nhiên là (promotion_code, checkout_attempt_id); order_id gắn sau khi tạo đơn, UNIQUE(promotion_code, order_id).
 * Hạn mức: COUNT(held + used) ≤ promotion.limit, kiểm dưới khóa.
 */
export const CouponUsage = model
  .define("coupon_usage", {
    id: model.id({ prefix: "cpu" }).primaryKey(),
    promotion_code: model.text(),
    promotion_id: model.text().nullable(),
    checkout_attempt_id: model.text(),
    order_id: model.text().nullable(),
    state: model.enum([...COUPON_USAGE_STATES]).default("held"),
  })
  .indexes([
    {
      name: "IDX_coupon_usage_code_attempt_unique",
      on: ["promotion_code", "checkout_attempt_id"],
      unique: true,
      where: null,
    },
    {
      name: "IDX_coupon_usage_code_order_unique",
      on: ["promotion_code", "order_id"],
      unique: true,
      where: "order_id IS NOT NULL",
    },
    { name: "IDX_coupon_usage_code_state", on: ["promotion_code", "state"], where: null },
  ]);

/**
 * Token liên kết tra cứu đơn đã đổi thành phiên (POST01, T-021): mỗi token chỉ đổi MỘT lần — UNIQUE(token_hash) ở DB,
 * lần đổi thứ hai va UNIQUE. Chỉ lưu SHA-256 của token (không lưu token). `expires_at` = hạn của token, để dọn dòng cũ.
 */
export const OrderAccessRedemption = model
  .define("order_access_redemption", {
    id: model.id({ prefix: "oacr" }).primaryKey(),
    token_hash: model.text(),
    order_id: model.text(),
    expires_at: model.dateTime(),
  })
  .indexes([
    {
      name: "IDX_order_access_redemption_token_hash_unique",
      on: ["token_hash"],
      unique: true,
      where: null,
    },
    { name: "IDX_order_access_redemption_expires_at", on: ["expires_at"], where: null },
  ]);

/**
 * Bộ đếm giới hạn tần suất cửa sổ cố định, dùng chung giữa các instance (tra cứu/xem/hủy đơn — AT20): một câu UPSERT
 * `count = count + 1 RETURNING count` nên đồng thời vẫn đếm đúng. `bucket` = loại + khóa đã băm (không lưu SĐT thô).
 */
export const RateLimitCounter = model
  .define("rate_limit_counter", {
    id: model.id({ prefix: "rlc" }).primaryKey(),
    bucket: model.text(),
    window_start: model.dateTime(),
    count: model.number().default(0),
  })
  .indexes([
    {
      name: "IDX_rate_limit_counter_bucket_window_unique",
      on: ["bucket", "window_start"],
      unique: true,
      where: null,
    },
    { name: "IDX_rate_limit_counter_window_start", on: ["window_start"], where: null },
  ])
  .checks([{ name: "rate_limit_counter_count_nonneg", expression: (c) => `${c.count} >= 0` }]);

/**
 * Circuit breaker chi phí của job nền/outbox (T-097, OPS-COST-004) — trạng thái DÙNG CHUNG mọi bản sao (ARC-RES-005):
 * mọi chuyển trạng thái là MỘT câu UPDATE có điều kiện trạng thái cũ (lib/outbox/breaker.ts) nên đúng một bản sao
 * thắng mỗi lần mở/thử. `breaker_key` = adapter/bộ xử lý (`notify`, loại sự kiện…). Ngân sách lượt gọi theo ngày đếm ở
 * `rate_limit_counter` (bucket `breaker.budget:<key>`), không ở đây.
 */
export const JobBreaker = model
  .define("job_breaker", {
    id: model.id({ prefix: "jbr" }).primaryKey(),
    breaker_key: model.text(),
    state: model.enum([...JOB_BREAKER_STATES]).default("closed"),
    /** Số sự kiện KHÁC NHAU lỗi tạm liên tiếp (một sự kiện thử lại nhiều lần chỉ tính một — đã có backoff riêng). */
    consecutive_failures: model.number().default(0),
    /** Id outbox của lần lỗi gần nhất (chỉ id — không payload) để không đếm lặp cùng sự kiện. */
    last_failed_event_id: model.text().nullable(),
    open_until: model.dateTime().nullable(),
    probe_until: model.dateTime().nullable(),
    trip_reason: model.enum([...JOB_BREAKER_TRIP_REASONS]).nullable(),
    trip_count: model.number().default(0),
  })
  .indexes([{ name: "IDX_job_breaker_key_unique", on: ["breaker_key"], unique: true, where: null }])
  .checks([
    {
      name: "job_breaker_consecutive_failures_nonneg",
      expression: (c) => `${c.consecutive_failures} >= 0`,
    },
    { name: "job_breaker_trip_count_nonneg", expression: (c) => `${c.trip_count} >= 0` },
    {
      name: "job_breaker_open_has_until",
      expression: (c) => `${c.state} <> 'open' OR ${c.open_until} IS NOT NULL`,
    },
    {
      name: "job_breaker_half_open_has_probe",
      expression: (c) => `${c.state} <> 'half_open' OR ${c.probe_until} IS NOT NULL`,
    },
  ]);
