import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/knex";
import type { Logger } from "@medusajs/framework/types";
import { generateEntityId, MedusaService } from "@medusajs/framework/utils";
import {
  decideOnCapture,
  orderMachine,
  type CaptureDecision,
  type LedgerEntry,
  type OrderState,
  type RefundState,
} from "@x-shop/domain";
import {
  ACTIVE_ATTEMPT_STATES,
  COUNTED_COUPON_STATES,
  OPS_EXCEPTION_ACTIVE_SCOPES,
  OPS_EXCEPTION_KINDS,
  type JobBreakerState,
  type JobBreakerTripReason,
  type OpsExceptionKind,
  type PaymentMethod,
} from "./models/constants";
import {
  CartVersion,
  CheckoutAttempt,
  CheckoutQuote,
  CouponUsage,
  JobBreaker,
  OpsException,
  OrderAccessRedemption,
  OrderFinance,
  OutboxEvent,
  PaymentAttempt,
  PaymentLedger,
  RateLimitCounter,
  WebhookInbox,
} from "./models/checkout-models";
import { assertOutboxPayload } from "../../lib/outbox/payload";
import { sampleAt, windowStartMs, type WindowSample } from "../../lib/security/sliding-window";

/** Phần tối thiểu của repository Medusa (MikroOrmBaseRepository) dùng cho câu lệnh nguyên tử. */
interface BaseRepositoryLike {
  getFreshManager(): SqlEntityManager;
  transaction<T>(task: (manager: SqlEntityManager) => Promise<T>): Promise<T>;
}

type Row = Record<string, unknown>;

export interface NewAttemptInput {
  cart_id: string;
  cart_version: number;
  idempotency_scope: string;
  idempotency_key: string;
  payload_hash: string;
  quote_id: string;
  payment_method: PaymentMethod;
  lease_until: Date;
}

export interface FinalizeAttemptInput {
  attempt_id: string;
  order_id: string;
  cart_id: string;
  cart_version: number;
  /** Trạng thái đích của order_finance (đã kiểm bằng orderMachine). */
  order_state: "placed" | "awaiting_payment";
  hold_expires_at: Date | null;
  cod_confirm_by: Date | null;
  outbox: { event_key: string; type: string; payload: Record<string, unknown> };
}

export interface OpsExceptionInput {
  kind: (typeof OPS_EXCEPTION_KINDS)[number];
  dedupe_key: string;
  order_id?: string | null;
  amount?: number | null;
  priority?: "low" | "normal" | "high" | "urgent";
  due_at?: Date | null;
  detail?: Record<string, unknown> | null;
}

export interface OutboxClaim {
  id: string;
  event_key: string;
  aggregate_id: string;
  type: string;
  payload: Record<string, unknown>;
  /** Số lần đã thử TRƯỚC lần này. */
  attempts: number;
}

/** Trạng thái một circuit breaker job nền (bảng `job_breaker`, T-097). */
export interface JobBreakerSnapshot {
  state: JobBreakerState;
  consecutive_failures: number;
  open_until: Date | null;
  probe_until: Date | null;
  trip_reason: JobBreakerTripReason | null;
}

const dateOrNull = (v: unknown): Date | null => (v == null ? null : new Date(v as string | Date));

function breakerSnapshot(r: Row): JobBreakerSnapshot {
  return {
    state: String(r.state) as JobBreakerState,
    consecutive_failures: Number(r.consecutive_failures),
    open_until: dateOrNull(r.open_until),
    probe_until: dateOrNull(r.probe_until),
    trip_reason: (r.trip_reason ?? null) as JobBreakerTripReason | null,
  };
}

export type CaptureOutcome =
  { duplicate: true } | { duplicate: false; decision: CaptureDecision; state_before: OrderState };

const json = (value: unknown) => JSON.stringify(value ?? null);

/**
 * Khoá advisory tuần tự hoá `openOpsExceptionIfNoneActive` (T-158, D-099; dạng khoá D-107): dạng HAI khoá int4
 * `(hashtext(OPS_EXCEPTION_LOCK_NS), hashtext(<khoá>))` — không gian riêng (`pg_locks.objsubid = 2`), không lẫn với khoá
 * một bigint `hashtext(...)` của module khác (vd. khoá theo đơn của returns mà trigger x_refund dò ở `objsubid = 1`).
 */
export const OPS_EXCEPTION_LOCK_NS = "x-shop:ops-exception";
/** Chờ khoá advisory tối đa (ms) — người giữ chỉ giữ trong MỘT câu INSERT; quá → ghi dự phòng không khoá (D-105). */
export const OPS_EXCEPTION_LOCK_TIMEOUT_MS = 5_000;
/** Trần thời gian mỗi câu trong giao dịch kiểm-rồi-tạo (ms). */
export const OPS_EXCEPTION_STATEMENT_TIMEOUT_MS = 10_000;

/** Mã lỗi PG khi chờ khoá quá `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Khoá advisory của một lời gọi `openOpsExceptionIfNoneActive`: không phạm vi → `kind`; có phạm vi → kind + giá trị phạm
 * vi (JSON khoá đã sắp xếp — thứ tự `active_scope` không đổi khoá).
 */
export function opsExceptionLockKey(kind: string, scope: Readonly<Record<string, unknown>> | null): string {
  if (scope === null) return kind;
  const ordered = Object.keys(scope)
    .sort()
    .map((k) => [k, scope[k]]);
  return `${kind}:${JSON.stringify(ordered)}`;
}

/**
 * Hàng rào D-107: `active_scope` phải đúng dạng đã khai cho kind ở `OPS_EXCEPTION_ACTIVE_SCOPES` (so như tập — thứ tự
 * không quan trọng; trùng khoá là sai). Trả các khoá theo thứ tự đã khai.
 */
function assertDeclaredScope(kind: OpsExceptionKind, activeScope: readonly string[]): readonly string[] {
  const declared = OPS_EXCEPTION_ACTIVE_SCOPES[kind];
  if (declared === undefined) {
    throw new Error(
      `openOpsExceptionIfNoneActive: kind ${kind} chưa khai dạng phạm vi trong OPS_EXCEPTION_ACTIVE_SCOPES`,
    );
  }
  const given = [...activeScope].sort();
  const want = [...declared].sort();
  if (given.length !== want.length || given.some((k, i) => k !== want[i])) {
    throw new Error(
      `openOpsExceptionIfNoneActive: kind ${kind} khai phạm vi [${declared.join(",")}], nhận [${activeScope.join(",")}]`,
    );
  }
  return declared;
}

/**
 * Giá trị phạm vi lấy từ `detail`. Khoá thiếu (`undefined`) → `null` — VÀ chính `detail` được ghi cũng mang `null` (xem
 * `openOpsExceptionIfNoneActive`), nên dòng đã ghi khớp lại phạm vi của nó. Chỉ nhận giá trị vô hướng: với object/array,
 * `@>` là "chứa" chứ không phải "bằng" nên dedupe sai — đó là lỗi lập trình, ném ngay.
 */
function scopeFromDetail(
  activeScope: readonly string[],
  detail: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean | null> {
  const scope: Record<string, string | number | boolean | null> = {};
  for (const k of activeScope) {
    const v = detail?.[k] ?? null;
    if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw new TypeError(`active_scope "${k}": giá trị trong detail phải là chuỗi/số/boolean/null`);
    }
    scope[k] = v;
  }
  return scope;
}

/**
 * JSON payload outbox SAU khi đã kiểm (T-149 — BE-JOB-007): kiểm đúng dạng sẽ lưu và worker sẽ nhận (sau JSON, khoá
 * `undefined` bị bỏ). Sai shape → ném trước khi chạm DB.
 */
function outboxJson(type: string, payload: Record<string, unknown>): string {
  const body = json(payload);
  assertOutboxPayload(type, JSON.parse(body));
  return body;
}

/**
 * Service của module `checkout`: CRUD sinh từ model DSL (MedusaService) + các thao tác cần NGUYÊN TỬ ở Postgres
 * (INSERT … ON CONFLICT, UPDATE có điều kiện trạng thái). Ràng buộc nghiệp vụ nằm ở DB; các hàm này chỉ diễn đạt
 * "làm nếu điều kiện còn đúng" để đua đồng thời có đúng một bên thắng.
 */
class CheckoutModuleService extends MedusaService({
  CheckoutQuote,
  CartVersion,
  CheckoutAttempt,
  OrderFinance,
  PaymentAttempt,
  PaymentLedger,
  WebhookInbox,
  OutboxEvent,
  OpsException,
  CouponUsage,
  OrderAccessRedemption,
  RateLimitCounter,
  JobBreaker,
}) {
  protected readonly repo_: BaseRepositoryLike;
  protected readonly logger_: Pick<Logger, "warn"> | undefined;

  constructor(container: { baseRepository: BaseRepositoryLike; logger?: Logger }, ...rest: unknown[]) {
    super(container, ...rest);
    this.repo_ = container.baseRepository;
    this.logger_ = container.logger;
  }

  private async exec(sql: string, params: unknown[] = [], em?: SqlEntityManager): Promise<Row[]> {
    const manager = em ?? this.repo_.getFreshManager();
    return (await manager.execute(sql, params, "all")) as Row[];
  }

  /**
   * Ghi nhận nội dung giỏ vừa quan sát: lần đầu → version 1; fingerprint đổi → version + 1 và bỏ đóng băng; giữ nguyên
   * → giữ version. Một câu UPSERT nên đồng thời vẫn đơn điệu.
   */
  async observeCartVersion(
    cartId: string,
    fingerprint: string,
  ): Promise<{ version: number; frozen_by_attempt: string | null }> {
    const rows = await this.exec(
      `INSERT INTO cart_version (id, cart_id, version, fingerprint)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (cart_id) DO UPDATE SET
         version = CASE WHEN cart_version.fingerprint = EXCLUDED.fingerprint
                        THEN cart_version.version ELSE cart_version.version + 1 END,
         frozen_by_attempt = CASE WHEN cart_version.fingerprint = EXCLUDED.fingerprint
                                  THEN cart_version.frozen_by_attempt ELSE NULL END,
         fingerprint = EXCLUDED.fingerprint,
         updated_at = CASE WHEN cart_version.fingerprint = EXCLUDED.fingerprint
                           THEN cart_version.updated_at ELSE now() END
       RETURNING version, frozen_by_attempt`,
      [generateEntityId(undefined, "cver"), cartId, fingerprint],
    );
    const row = rows[0] ?? {};
    return {
      version: Number(row.version),
      frozen_by_attempt: (row.frozen_by_attempt as string | null) ?? null,
    };
  }

  /** Phiên bản giỏ hiện tại (không ghi). */
  async currentCartVersion(cartId: string): Promise<{ version: number; fingerprint: string } | null> {
    const rows = await this.exec(`SELECT version, fingerprint FROM cart_version WHERE cart_id = ?`, [cartId]);
    const row = rows[0];
    return row ? { version: Number(row.version), fingerprint: String(row.fingerprint) } : null;
  }

  /**
   * Tạo attempt `preparing` nếu không va ràng buộc nào (idempotency key hoặc phiên bản giỏ đang hoạt động). Va → null;
   * caller đọc lại attempt đang giữ chỗ (S-003, DATA02).
   */
  async insertAttemptIfAbsent(input: NewAttemptInput): Promise<string | null> {
    const rows = await this.exec(
      `INSERT INTO checkout_attempt
         (id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash, quote_id, state,
          payment_method, lease_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        generateEntityId(undefined, "chk"),
        input.cart_id,
        input.cart_version,
        input.idempotency_scope,
        input.idempotency_key,
        input.payload_hash,
        input.quote_id,
        input.payment_method,
        input.lease_until,
      ],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  /** Attempt đang hoạt động (preparing/ready) của một phiên bản giỏ. */
  async findActiveAttemptId(cartId: string, cartVersion: number): Promise<string | null> {
    const rows = await this.exec(
      `SELECT id FROM checkout_attempt
       WHERE cart_id = ? AND cart_version = ? AND state IN (${ACTIVE_ATTEMPT_STATES.map(() => "?").join(", ")})
         AND deleted_at IS NULL
       LIMIT 1`,
      [cartId, cartVersion, ...ACTIVE_ATTEMPT_STATES],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  /** preparing → failed (chỉ khi còn preparing). Trả true nếu chính lời gọi này chuyển trạng thái. */
  async failAttempt(
    attemptId: string,
    errorCode: string,
    errorDetail: Record<string, unknown> | null,
  ): Promise<boolean> {
    const rows = await this.exec(
      `UPDATE checkout_attempt SET state = 'failed', error_code = ?, error_detail = ?::jsonb, updated_at = now()
       WHERE id = ? AND state = 'preparing' RETURNING id`,
      [errorCode, json(errorDetail), attemptId],
    );
    return rows.length === 1;
  }

  /**
   * Mở lại attempt hỏng vì lỗi tạm (BUSY_RETRY) để retry CÙNG key chạy tiếp — chỉ một request thắng; phiên bản giỏ đã
   * có attempt khác hoạt động → không mở (partial UNIQUE chặn, trả false).
   */
  async reopenRetryableAttempt(
    attemptId: string,
    retryableCodes: readonly string[],
    leaseUntil: Date,
  ): Promise<boolean> {
    if (retryableCodes.length === 0) return false;
    try {
      const rows = await this.exec(
        `UPDATE checkout_attempt
         SET state = 'preparing', error_code = NULL, error_detail = NULL, lease_until = ?, updated_at = now()
         WHERE id = ? AND state = 'failed' AND error_code IN (${retryableCodes.map(() => "?").join(", ")})
         RETURNING id`,
        [leaseUntil, attemptId, ...retryableCodes],
      );
      return rows.length === 1;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  /** Số lượt mã đang tính vào hạn mức (held + used). Gọi dưới khóa `promotion:<code>`. */
  async countCountedCouponUsage(promotionCode: string): Promise<number> {
    const rows = await this.exec(
      `SELECT count(*)::int AS n FROM coupon_usage
       WHERE promotion_code = ? AND state IN (${COUNTED_COUPON_STATES.map(() => "?").join(", ")})
         AND deleted_at IS NULL`,
      [promotionCode, ...COUNTED_COUPON_STATES],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Giữ một lượt mã cho attempt (idempotent theo (code, attempt)). */
  async holdCoupon(input: {
    promotion_code: string;
    promotion_id: string | null;
    attempt_id: string;
  }): Promise<void> {
    await this.exec(
      `INSERT INTO coupon_usage (id, promotion_code, promotion_id, checkout_attempt_id, state)
       VALUES (?, ?, ?, ?, 'held')
       ON CONFLICT (promotion_code, checkout_attempt_id) DO UPDATE SET state = 'held', updated_at = now()
         WHERE coupon_usage.state = 'released' AND coupon_usage.order_id IS NULL`,
      [generateEntityId(undefined, "cpu"), input.promotion_code, input.promotion_id, input.attempt_id],
    );
  }

  /** Bù trừ: lượt đang giữ của attempt → released (đúng một lần). Trả số dòng đã nhả. */
  async releaseCouponHold(attemptId: string): Promise<number> {
    const rows = await this.exec(
      `UPDATE coupon_usage SET state = 'released', updated_at = now()
       WHERE checkout_attempt_id = ? AND state = 'held' RETURNING id`,
      [attemptId],
    );
    return rows.length;
  }

  /** Ghi order_finance ở trạng thái `preparing`; trùng display_ref → false để caller sinh mã khác. */
  async insertOrderFinance(input: {
    order_id: string;
    display_ref: string;
    checkout_attempt_id: string;
    cart_id: string;
    total: number;
    payment_method: PaymentMethod;
    policy_version: string;
    quote: unknown;
    address: unknown;
    contact: unknown;
  }): Promise<string | null> {
    const rows = await this.exec(
      `INSERT INTO order_finance
         (id, order_id, display_ref, checkout_attempt_id, cart_id, state, total, payment_method, policy_version,
          quote, address, contact)
       VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)
       ON CONFLICT (display_ref) DO NOTHING
       RETURNING id`,
      [
        generateEntityId(undefined, "ofin"),
        input.order_id,
        input.display_ref,
        input.checkout_attempt_id,
        input.cart_id,
        input.total,
        input.payment_method,
        input.policy_version,
        json(input.quote),
        json(input.address),
        json(input.contact),
      ],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  /** Bù trừ: xoá order_finance còn `preparing` của đơn (đơn native đã bị xoá bởi bù trừ của createOrderWorkflow). */
  async discardPreparingOrderFinance(orderId: string): Promise<void> {
    await this.exec(`DELETE FROM order_finance WHERE order_id = ? AND state = 'preparing'`, [orderId]);
  }

  async insertPaymentAttempt(input: {
    order_id: string;
    provider: string;
    txn_ref: string;
    amount: number;
    expires_at: Date;
  }): Promise<string> {
    const rows = await this.exec(
      `INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at)
       VALUES (?, ?, ?, ?, ?, 'created', ?) RETURNING id`,
      [
        generateEntityId(undefined, "payatt"),
        input.order_id,
        input.provider,
        input.txn_ref,
        input.amount,
        input.expires_at,
      ],
    );
    return String(rows[0]?.id);
  }

  /** created → pending kèm URL thanh toán đã ký. */
  async markPaymentAttemptPending(id: string, paymentUrl: string): Promise<void> {
    await this.exec(
      `UPDATE payment_attempt SET state = 'pending', payment_url = ?, updated_at = now()
       WHERE id = ? AND state = 'created'`,
      [paymentUrl, id],
    );
  }

  /** Bù trừ: attempt chưa gửi khách (created/pending) → failed. */
  async failOpenPaymentAttempt(id: string): Promise<void> {
    await this.exec(
      `UPDATE payment_attempt SET state = 'failed', updated_at = now()
       WHERE id = ? AND state IN ('created', 'pending')`,
      [id],
    );
  }

  /**
   * Bước 9 của submit, MỘT transaction: order_finance preparing → placed/awaiting_payment, lượt mã gắn đơn, attempt →
   * ready, đóng băng phiên bản giỏ, outbox. Attempt không còn `preparing` (vd job đối chiếu đã bù trừ) → ném lỗi để
   * workflow bù trừ phần đã tạo.
   */
  async finalizeAttempt(input: FinalizeAttemptInput, quoteSnapshot: unknown): Promise<void> {
    // Kiểm payload TRƯỚC khi mở transaction (T-149): sai shape là lỗi lập trình, không đụng attempt/đơn.
    const outboxPayload = outboxJson(input.outbox.type, input.outbox.payload);
    await this.repo_.transaction(async (em) => {
      const fin = await this.exec(
        `UPDATE order_finance
         SET state = ?, hold_expires_at = ?, cod_confirm_by = ?, version = version + 1, updated_at = now()
         WHERE order_id = ? AND state = 'preparing' RETURNING id`,
        [input.order_state, input.hold_expires_at, input.cod_confirm_by, input.order_id],
        em,
      );
      if (fin.length !== 1)
        throw new Error(`order_finance của ${input.order_id} không còn ở trạng thái preparing`);
      const att = await this.exec(
        `UPDATE checkout_attempt
         SET state = 'ready', order_id = ?, hold_expires_at = ?, quote = ?::jsonb, updated_at = now()
         WHERE id = ? AND state = 'preparing' RETURNING id`,
        [input.order_id, input.hold_expires_at, json(quoteSnapshot), input.attempt_id],
        em,
      );
      if (att.length !== 1)
        throw new Error(`checkout attempt ${input.attempt_id} không còn ở trạng thái preparing`);
      await this.exec(
        `UPDATE coupon_usage SET order_id = ?, updated_at = now()
         WHERE checkout_attempt_id = ? AND state = 'held'`,
        [input.order_id, input.attempt_id],
        em,
      );
      await this.exec(
        `UPDATE cart_version SET frozen_by_attempt = ?, updated_at = now()
         WHERE cart_id = ? AND version = ?`,
        [input.attempt_id, input.cart_id, input.cart_version],
        em,
      );
      await this.exec(
        `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, next_attempt_at)
         VALUES (?, ?, ?, ?, ?::jsonb, 'pending', now())
         ON CONFLICT (event_key) DO NOTHING`,
        [
          generateEntityId(undefined, "obx"),
          input.outbox.event_key,
          input.order_id,
          input.outbox.type,
          outboxPayload,
        ],
        em,
      );
    });
  }

  /* ------------------------------------------------------------ thanh toán (T-011) */

  /**
   * Lưu thông báo TRƯỚC khi xử lý (§4 bước 2). Trùng (provider, event_key) → trả bản ghi đã có (kèm kết quả nếu đã
   * xử lý) để caller trả lại kết quả cũ.
   */
  async recordInbox(input: {
    provider: string;
    event_key: string;
    source: string;
    payload: Record<string, unknown>;
    payload_hash: string;
    verified: boolean;
  }): Promise<{ id: string; inserted: boolean; result: Record<string, unknown> | null }> {
    const inserted = await this.exec(
      `INSERT INTO webhook_inbox (id, provider, event_key, source, payload, payload_hash, verified)
       VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)
       ON CONFLICT (provider, event_key) DO NOTHING RETURNING id`,
      [
        generateEntityId(undefined, "whin"),
        input.provider,
        input.event_key,
        input.source,
        json(input.payload),
        input.payload_hash,
        input.verified,
      ],
    );
    if (inserted[0]) return { id: String(inserted[0].id), inserted: true, result: null };
    const rows = await this.exec(
      `SELECT id, result, processed_at FROM webhook_inbox WHERE provider = ? AND event_key = ?`,
      [input.provider, input.event_key],
    );
    const row = rows[0] ?? {};
    return {
      id: String(row.id),
      inserted: false,
      // processed_at là timestamp (Date | null) từ pg — chỉ có/không, không có "rỗng".
      result: row.processed_at != null ? ((row.result as Record<string, unknown> | null) ?? null) : null,
    };
  }

  /** Ghi kết quả xử lý (lần đầu thắng). */
  async markInboxProcessed(id: string, result: Record<string, unknown>): Promise<void> {
    await this.exec(
      `UPDATE webhook_inbox SET result = ?::jsonb, processed_at = now(), updated_at = now()
       WHERE id = ? AND processed_at IS NULL`,
      [json(result), id],
    );
  }

  /** Mở ngoại lệ vận hành; trùng `dedupe_key` → không mở thêm. Trả true nếu vừa mở. */
  async openOpsException(input: OpsExceptionInput, em?: SqlEntityManager): Promise<boolean> {
    const rows = await this.exec(
      `INSERT INTO ops_exception (id, kind, dedupe_key, order_id, amount, priority, due_at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        generateEntityId(undefined, "opx"),
        input.kind,
        input.dedupe_key,
        input.order_id ?? null,
        input.amount ?? null,
        input.priority ?? "normal",
        input.due_at ?? null,
        json(input.detail ?? null),
      ],
      em,
    );
    return rows.length === 1;
  }

  /**
   * Mở ngoại lệ chỉ khi CHƯA có ngoại lệ đang hoạt động (open/in_progress) cùng `kind` — và, nếu có `active_scope`,
   * cùng giá trị các khoá đó trong `detail` (vd. `["product_id"]`: mỗi sản phẩm một ngoại lệ đang mở; `[]`/không truyền:
   * một ngoại lệ cho cả kind). Khác `openOpsException` (dedupe vĩnh viễn theo khoá): xử lý xong mà lỗi tái diễn thì mở lại.
   *
   * Dạng phạm vi mỗi kind khai MỘT lần ở `OPS_EXCEPTION_ACTIVE_SCOPES` (D-107): kind chưa khai hoặc `active_scope` khác
   * dạng đã khai → ném lỗi trước khi chạm DB (hai dạng cho một kind giao nhau về điều kiện nhưng khác khoá).
   *
   * Tự tuần tự hoá (T-158, D-099) — người gọi KHÔNG cần khoá riêng: kiểm-rồi-tạo chạy trong MỘT giao dịch giữ
   * `pg_advisory_xact_lock` theo kind (không phạm vi) hoặc kind + giá trị phạm vi (hai sản phẩm khác nhau không chờ
   * nhau). INSERT … WHERE NOT EXISTS một mình không chặn hai lời gọi song song. Mọi câu trong giao dịch có trần
   * `OPS_EXCEPTION_STATEMENT_TIMEOUT_MS`; chờ khoá quá `OPS_EXCEPTION_LOCK_TIMEOUT_MS` (PG 55P03) → log warn (chỉ kind,
   * tên khoá phạm vi, mã lỗi — không giá trị) rồi ghi dự phòng MỘT lần không khoá trong giao dịch mới (D-105: thà có thể
   * trùng còn hơn mất dấu); dự phòng cũng lỗi → warn mã lỗi của lần đó (chỉ mã) rồi ném lỗi 55P03 gốc. Timeout đặt bằng
   * `set_config(..., true)` = cục bộ giao dịch: kết nối trả về pool dùng chung không mang theo (có test probe pool).
   *
   * Khoá phạm vi thiếu trong `detail` → ghi `null` cho khoá đó vào `detail` (🟢b review T-156): phạm vi so khớp `null`,
   * nên dòng đã ghi phải mang `null` (JSON bỏ khoá `undefined`) — nếu không, lần gọi sau không dedupe được.
   *
   * Luôn tự mở giao dịch riêng (không nhận `em` của người gọi): `set_config(..., true)` đổi timeout tới hết giao dịch và
   * khoá `xact` giữ tới commit — chạy trong giao dịch dài của người gọi sẽ giữ khoá suốt giao dịch đó.
   */
  async openOpsExceptionIfNoneActive(
    input: OpsExceptionInput & { active_scope?: readonly string[] },
  ): Promise<boolean> {
    const scopeKeys = assertDeclaredScope(input.kind, input.active_scope ?? []);
    const scope = scopeKeys.length > 0 ? scopeFromDetail(scopeKeys, input.detail) : null;
    // Dòng ghi mang đủ khoá phạm vi (thiếu → null) để khớp lại `detail @> scope` ở lần gọi sau.
    const detail = scope === null ? (input.detail ?? null) : { ...input.detail, ...scope };
    const lockKey = opsExceptionLockKey(input.kind, scope);
    // SQL NULL (không phải chuỗi JSON 'null' — `'null'::jsonb IS NULL` là false) = không lọc theo detail.
    const scopeJson = scope === null ? null : json(scope);
    const run = (locked: boolean) => async (tx: SqlEntityManager) => {
      await this.exec(
        `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
        [`${OPS_EXCEPTION_LOCK_TIMEOUT_MS}ms`, `${OPS_EXCEPTION_STATEMENT_TIMEOUT_MS}ms`],
        tx,
      );
      if (locked) {
        await this.exec(
          `SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
          [OPS_EXCEPTION_LOCK_NS, lockKey],
          tx,
        );
      }
      const rows = await this.exec(
        `INSERT INTO ops_exception (id, kind, dedupe_key, order_id, amount, priority, due_at, detail)
         SELECT ?, ?::text, ?, ?, ?, ?, ?, ?::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM ops_exception WHERE kind = ?::text AND state IN ('open', 'in_progress') AND deleted_at IS NULL
               AND (?::jsonb IS NULL OR detail @> ?::jsonb))
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          generateEntityId(undefined, "opx"),
          input.kind,
          input.dedupe_key,
          input.order_id ?? null,
          input.amount ?? null,
          input.priority ?? "normal",
          input.due_at ?? null,
          json(detail),
          input.kind,
          scopeJson,
          scopeJson,
        ],
        tx,
      );
      return rows.length === 1;
    };
    try {
      return await this.repo_.transaction(run(true));
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== LOCK_NOT_AVAILABLE) throw e;
      this.logger_?.warn(
        `[ops-exception] Chờ khoá mở ngoại lệ quá ${OPS_EXCEPTION_LOCK_TIMEOUT_MS}ms — ghi dự phòng không khoá: ` +
          `kind=${input.kind} scope=[${scopeKeys.join(",")}] code=${LOCK_NOT_AVAILABLE}`,
      );
      try {
        return await this.repo_.transaction(run(false));
      } catch (fallbackError) {
        // Chỉ mã lỗi của lần dự phòng (không message — knex chép giá trị bind vào message); vẫn ném lỗi 55P03 gốc.
        const code = (fallbackError as { code?: unknown } | null)?.code;
        this.logger_?.warn(
          `[ops-exception] Ghi dự phòng không khoá cũng lỗi: kind=${input.kind} scope=[${scopeKeys.join(",")}] ` +
            `code=${typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "unknown"}`,
        );
        throw e;
      }
    }
  }

  /** Attempt còn mở (created/pending/unknown) → `to` (failed|unknown) theo máy trạng thái thanh toán. */
  async movePaymentAttempt(
    id: string,
    to: "failed" | "unknown",
    providerTxnNo: string | null = null,
    em?: SqlEntityManager,
  ): Promise<boolean> {
    const from = to === "failed" ? ["created", "pending", "unknown"] : ["created", "pending"];
    const rows = await this.exec(
      `UPDATE payment_attempt SET state = ?, provider_txn_no = COALESCE(?, provider_txn_no), updated_at = now()
       WHERE id = ? AND state IN (${from.map(() => "?").join(", ")}) RETURNING id`,
      [to, providerTxnNo, id, ...from],
      em,
    );
    return rows.length === 1;
  }

  /**
   * Ghi MỘT khoản thu đã xác minh và áp quyết định của domain trong cùng transaction (§4 bước 5). Gọi dưới khóa
   * `order:<id>`. UNIQUE(provider, provider_txn_id, kind) va → `duplicate` (đã ghi, không làm gì thêm — AT06).
   */
  async applyCapture(input: {
    order_id: string;
    payment_attempt_id: string;
    provider: string;
    provider_txn_id: string;
    amount: number;
    now: Date;
  }): Promise<CaptureOutcome> {
    return this.repo_.transaction(async (em) => {
      const ins = await this.exec(
        `INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state)
         VALUES (?, ?, 'capture', ?, ?, ?, 'succeeded')
         ON CONFLICT (provider, provider_txn_id, kind) DO NOTHING RETURNING id`,
        [
          generateEntityId(undefined, "pled"),
          input.order_id,
          input.amount,
          input.provider,
          input.provider_txn_id,
        ],
        em,
      );
      if (ins.length === 0) return { duplicate: true } as const;
      const finRows = await this.exec(
        `SELECT state, total FROM order_finance WHERE order_id = ? FOR UPDATE`,
        [input.order_id],
        em,
      );
      const fin = finRows[0];
      if (!fin) throw new Error(`Không có order_finance cho đơn ${input.order_id}`);
      const ledgerRows = await this.exec(
        `SELECT kind, amount, provider_txn_id, refund_id, state FROM payment_ledger WHERE order_id = ?`,
        [input.order_id],
        em,
      );
      const entries: LedgerEntry[] = ledgerRows.map((r) =>
        r.kind === "capture"
          ? { kind: "capture", amount: Number(r.amount), providerTxnId: String(r.provider_txn_id) }
          : {
              kind: "refund",
              amount: Number(r.amount),
              refundId: String(r.refund_id ?? ""),
              state: String(r.state) as RefundState,
            },
      );
      const stateBefore = String(fin.state) as OrderState;
      const total = Number(fin.total);
      const decision = decideOnCapture(stateBefore, total, entries, input.amount);
      await this.exec(
        `UPDATE payment_attempt SET state = 'captured', provider_txn_no = ?, updated_at = now()
         WHERE id = ? AND state IN ('created', 'pending', 'unknown', 'authorized')`,
        [input.provider_txn_id, input.payment_attempt_id],
        em,
      );
      const exception = (kind: OpsExceptionInput["kind"], amount: number, priority: "normal" | "high") =>
        this.openOpsException(
          {
            kind,
            dedupe_key: `${kind}:${input.provider}:${input.provider_txn_id}`,
            order_id: input.order_id,
            amount,
            priority,
            due_at: new Date(input.now.getTime() + 24 * 3600_000),
            detail: { provider_txn_id: input.provider_txn_id, order_state: stateBefore, total },
          },
          em,
        );
      if (decision.action === "confirm_order") {
        const t = orderMachine.transition(stateBefore, "confirmed");
        if (!t.ok) throw new Error(t.message);
        await this.exec(
          `UPDATE order_finance SET state = 'confirmed', version = version + 1, updated_at = now()
           WHERE order_id = ? AND state = ?`,
          [input.order_id, stateBefore],
          em,
        );
        await this.exec(
          `UPDATE coupon_usage SET state = 'used', updated_at = now() WHERE order_id = ? AND state = 'held'`,
          [input.order_id],
          em,
        );
        await this.insertOutbox(
          `order.confirmed:${input.order_id}`,
          input.order_id,
          "order.confirmed",
          { order_id: input.order_id, provider_txn_id: input.provider_txn_id },
          em,
        );
        await this.insertOutbox(
          `payment.native_sync:${input.order_id}`,
          input.order_id,
          "payment.native_sync",
          { order_id: input.order_id, amount: total },
          em,
        );
        if (decision.overpaid > 0) await exception("overpayment", decision.overpaid, "high");
      } else if (decision.action === "exception") {
        await exception(decision.reason, decision.amount, "high");
      } else {
        await exception("payment_unknown", input.amount, "normal");
      }
      return { duplicate: false, decision, state_before: stateBefore } as const;
    });
  }

  /* ------------------------------------------------------------ xác nhận COD (T-026) */

  /**
   * Nhân viên xác nhận đơn COD (§6.3): `placed` → `confirmed` MỘT lần, trong một transaction cùng lượt mã → used và
   * outbox `order.confirmed`. Chỉ đơn COD; đơn chưa finalization (`preparing`) hay đã hủy không xác nhận được (AT34).
   * Gọi dưới khóa `order:<id>`.
   */
  async confirmCodOrder(
    orderId: string,
    actorId: string,
  ): Promise<"confirmed" | "already_confirmed" | "not_cod" | "invalid_state" | "not_found"> {
    return this.repo_.transaction(async (em) => {
      const rows = await this.exec(
        `SELECT state, payment_method, display_ref FROM order_finance WHERE order_id = ? FOR UPDATE`,
        [orderId],
        em,
      );
      const fin = rows[0];
      if (!fin) return "not_found";
      if (fin.payment_method !== "cod") return "not_cod";
      const state = String(fin.state) as OrderState;
      if (state === "confirmed" || state === "completed") return "already_confirmed";
      if (!orderMachine.canTransition(state, "confirmed") || state !== "placed") return "invalid_state";
      await this.exec(
        `UPDATE order_finance SET state = 'confirmed', version = version + 1, updated_at = now()
         WHERE order_id = ? AND state = 'placed'`,
        [orderId],
        em,
      );
      await this.exec(
        `UPDATE coupon_usage SET state = 'used', updated_at = now() WHERE order_id = ? AND state = 'held'`,
        [orderId],
        em,
      );
      await this.insertOutbox(
        `order.confirmed:${orderId}`,
        orderId,
        "order.confirmed",
        {
          order_id: orderId,
          display_ref: String(fin.display_ref),
          payment_method: "cod",
          confirmed_by: actorId,
        },
        em,
      );
      return "confirmed";
    });
  }

  /* ------------------------------------------------------------ job (T-012) */

  /** Đơn online còn chờ thanh toán đã quá hạn giữ hàng (biên: now >= hold_expires_at là hết hạn — DATA04). */
  async listExpiredHoldOrderIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.exec(
      `SELECT order_id FROM order_finance
       WHERE state = 'awaiting_payment' AND hold_expires_at <= ? AND deleted_at IS NULL
       ORDER BY hold_expires_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => String(r.order_id));
  }

  /**
   * Hủy đơn hết hạn (S-005) — MỘT transaction, chỉ khi đơn còn `awaiting_payment`: order_finance → cancelled, payment
   * attempt còn mở → failed, lượt mã → released, checkout attempt → failed (nhả phiên bản giỏ để checkout lại),
   * outbox `order.cancelled`. Trả false nếu đơn không còn chờ (một nhánh khác đã thắng).
   */
  async cancelExpiredOrder(orderId: string, reason: string): Promise<boolean> {
    return this.repo_.transaction(async (em) => {
      const fin = await this.exec(
        `UPDATE order_finance SET state = 'cancelled', version = version + 1, updated_at = now()
         WHERE order_id = ? AND state = 'awaiting_payment' RETURNING id`,
        [orderId],
        em,
      );
      if (fin.length !== 1) return false;
      await this.exec(
        `UPDATE payment_attempt SET state = 'failed', updated_at = now()
         WHERE order_id = ? AND state IN ('created', 'pending', 'unknown')`,
        [orderId],
        em,
      );
      await this.exec(
        `UPDATE coupon_usage SET state = 'released', updated_at = now() WHERE order_id = ? AND state = 'held'`,
        [orderId],
        em,
      );
      await this.exec(
        `UPDATE checkout_attempt SET state = 'failed', error_code = ?, updated_at = now()
         WHERE order_id = ? AND state = 'ready'`,
        [reason, orderId],
        em,
      );
      await this.insertOutbox(
        `order.cancelled:${orderId}`,
        orderId,
        "order.cancelled",
        { order_id: orderId, reason },
        em,
      );
      return true;
    });
  }

  /** Attempt `preparing` quá lease, hoặc đã nhận bù trừ nhưng chưa xong (`COMPENSATING`) — để job đối chiếu (AT10). */
  async listStaleAttempts(now: Date, limit: number): Promise<Array<{ id: string; cart_id: string }>> {
    const rows = await this.exec(
      `SELECT id, cart_id FROM checkout_attempt
       WHERE ((state = 'preparing' AND lease_until < ?) OR (state = 'compensated' AND error_code = 'COMPENSATING'))
         AND deleted_at IS NULL
       ORDER BY lease_until LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: String(r.id), cart_id: String(r.cart_id) }));
  }

  /**
   * Nhận quyền bù trừ: preparing (quá lease) → compensated/COMPENSATING. Sau bước này submit "xác sống" không chốt được
   * nữa (finalize đòi `preparing`). Đã COMPENSATING (lần trước dở) → vẫn trả true để làm tiếp.
   */
  async claimStaleAttempt(attemptId: string, now: Date): Promise<boolean> {
    const rows = await this.exec(
      `UPDATE checkout_attempt SET state = 'compensated', error_code = 'COMPENSATING', updated_at = now()
       WHERE id = ? AND ((state = 'preparing' AND lease_until < ?) OR (state = 'compensated' AND error_code = 'COMPENSATING'))
       RETURNING id`,
      [attemptId, now],
    );
    return rows.length === 1;
  }

  /** Dọn phần module của attempt đã nhận bù trừ: order_finance preparing → cancelled, payment → failed, mã → released. */
  async compensateAttemptRecords(attemptId: string, orderIds: string[]): Promise<void> {
    await this.repo_.transaction(async (em) => {
      if (orderIds.length > 0) {
        const marks = orderIds.map(() => "?").join(", ");
        await this.exec(
          `UPDATE order_finance SET state = 'cancelled', version = version + 1, updated_at = now()
           WHERE order_id IN (${marks}) AND state = 'preparing'`,
          orderIds,
          em,
        );
        await this.exec(
          `UPDATE payment_attempt SET state = 'failed', updated_at = now()
           WHERE order_id IN (${marks}) AND state IN ('created', 'pending', 'unknown')`,
          orderIds,
          em,
        );
      }
      await this.exec(
        `UPDATE coupon_usage SET state = 'released', updated_at = now()
         WHERE checkout_attempt_id = ? AND state = 'held'`,
        [attemptId],
        em,
      );
      await this.exec(
        `UPDATE checkout_attempt SET error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE id = ? AND state = 'compensated' AND error_code = 'COMPENSATING'`,
        [attemptId],
        em,
      );
    });
  }

  /** Đơn COD quá hạn xác nhận mà vẫn `placed`. */
  async listOverdueCodOrders(
    now: Date,
    limit: number,
  ): Promise<Array<{ order_id: string; display_ref: string }>> {
    const rows = await this.exec(
      `SELECT order_id, display_ref FROM order_finance
       WHERE state = 'placed' AND payment_method = 'cod' AND cod_confirm_by <= ? AND deleted_at IS NULL
       ORDER BY cod_confirm_by LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => ({ order_id: String(r.order_id), display_ref: String(r.display_ref) }));
  }

  /**
   * Nhận MỘT sự kiện outbox đến hạn (pending/failed, next_attempt_at <= now) — `FOR UPDATE SKIP LOCKED` + đẩy
   * next_attempt_at ra sau `leaseMs` nên hai dispatcher không nhận trùng; tiến trình chết → hết lease thì nhận lại.
   */
  async claimDueOutbox(now: Date, leaseMs: number): Promise<OutboxClaim | null> {
    const rows = await this.exec(
      `UPDATE outbox_event SET next_attempt_at = ?, updated_at = now()
       WHERE id = (
         SELECT id FROM outbox_event
         WHERE state IN ('pending', 'failed') AND next_attempt_at <= ? AND deleted_at IS NULL
         ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, event_key, aggregate_id, type, payload, attempts`,
      [new Date(now.getTime() + leaseMs), now],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      event_key: String(r.event_key),
      aggregate_id: String(r.aggregate_id),
      type: String(r.type),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      attempts: Number(r.attempts),
    };
  }

  async markOutboxSent(id: string): Promise<void> {
    await this.exec(
      `UPDATE outbox_event SET state = 'sent', last_error = NULL, updated_at = now() WHERE id = ?`,
      [id],
    );
  }

  /** Lỗi gửi: attempts + 1, hẹn lại (lũy thừa) hoặc `dead` khi hết lượt. */
  async markOutboxFailed(id: string, error: string, nextAttemptAt: Date | null): Promise<void> {
    await this.exec(
      `UPDATE outbox_event
       SET attempts = attempts + 1, state = ?, last_error = ?, next_attempt_at = COALESCE(?, next_attempt_at),
           updated_at = now()
       WHERE id = ?`,
      [nextAttemptAt ? "failed" : "dead", error.slice(0, 2000), nextAttemptAt, id],
    );
  }

  /** Đánh dấu sự kiện outbox đã xong khi việc của nó đã được làm ngay (không chờ dispatcher). */
  async markOutboxSentByKey(eventKey: string): Promise<void> {
    await this.exec(
      `UPDATE outbox_event SET state = 'sent', updated_at = now() WHERE event_key = ? AND state IN ('pending', 'failed')`,
      [eventKey],
    );
  }

  /**
   * Hoãn sự kiện đã nhận mà KHÔNG thử (breaker mở/bóp, T-097): chỉ dời `next_attempt_at`, không tăng `attempts`, không
   * đổi trạng thái — sự kiện vẫn nằm trong outbox và được nhận lại khi tới hạn (không mất). Sự kiện đã sang trạng thái
   * khác (sent/dead) thì không đụng.
   */
  async deferOutbox(id: string, until: Date): Promise<void> {
    await this.exec(
      `UPDATE outbox_event SET next_attempt_at = ?, updated_at = now()
       WHERE id = ? AND state IN ('pending', 'failed')`,
      [until, id],
    );
  }

  /* ------------------------------------------------------------ circuit breaker job nền (T-097) */

  /**
   * Trạng thái breaker `key` (đọc mới, ngoài giao dịch). Không có dòng = `closed`, chưa lỗi lần nào (dòng chỉ được tạo
   * khi có lỗi/mở). Mọi chuyển trạng thái dưới đây là MỘT câu có điều kiện trạng thái cũ → nhiều bản sao cùng gọi thì
   * đúng một bản thắng (READ COMMITTED: câu UPDATE chờ khoá dòng rồi xét lại WHERE trên bản mới nhất).
   *
   * `job_breaker` KHÔNG dùng xoá mềm (review T-097): cột `deleted_at` chỉ do model DSL tự thêm; mọi câu breaker bỏ qua nó
   * — một khoá = đúng một dòng (UNIQUE `breaker_key` gồm cả dòng có `deleted_at`), nên lọc ở câu này mà không lọc ở câu
   * kia sẽ làm breaker kẹt (INSERT trùng dòng đã "xoá", UPDATE lại bỏ qua nó).
   */
  async readJobBreaker(key: string): Promise<JobBreakerSnapshot | null> {
    const rows = await this.exec(
      `SELECT state, consecutive_failures, open_until, probe_until, trip_reason
       FROM job_breaker WHERE breaker_key = ?`,
      [key],
    );
    return rows[0] ? breakerSnapshot(rows[0]) : null;
  }

  /**
   * Hết nguội (`open` và `open_until` ≤ now) hoặc lượt thử trước quá hạn (`half_open` và `probe_until` ≤ now) → chuyển
   * `half_open` với hạn lượt thử `probeUntil`. Trả true = người gọi là lượt thử DUY NHẤT.
   */
  async claimJobBreakerProbe(key: string, now: Date, probeUntil: Date): Promise<boolean> {
    const rows = await this.exec(
      `UPDATE job_breaker SET state = 'half_open', probe_until = ?, updated_at = now()
       WHERE breaker_key = ?
         AND ((state = 'open' AND open_until <= ?) OR (state = 'half_open' AND probe_until <= ?))
       RETURNING id`,
      [probeUntil, key, now, now],
    );
    return rows.length === 1;
  }

  /**
   * Ghi một lỗi tạm của sự kiện `eventId`: tăng số lỗi liên tiếp CHỈ khi khác sự kiện lỗi gần nhất (một sự kiện thử lại
   * nhiều lần đã có backoff/trần lần riêng — không để một sự kiện hỏng chặn cả adapter). Trả trạng thái SAU khi ghi.
   */
  async recordJobBreakerFailure(key: string, eventId: string): Promise<JobBreakerSnapshot> {
    const rows = await this.exec(
      `INSERT INTO job_breaker (id, breaker_key, consecutive_failures, last_failed_event_id)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (breaker_key) DO UPDATE SET
         consecutive_failures = job_breaker.consecutive_failures
           + CASE WHEN job_breaker.last_failed_event_id IS DISTINCT FROM EXCLUDED.last_failed_event_id THEN 1 ELSE 0 END,
         last_failed_event_id = EXCLUDED.last_failed_event_id,
         updated_at = now()
       RETURNING state, consecutive_failures, open_until, probe_until, trip_reason`,
      [generateEntityId(undefined, "jbr"), key, eventId],
    );
    return breakerSnapshot(rows[0]!);
  }

  /**
   * Lượt gọi thành công: `half_open` → `closed`; `closed` → xoá đếm lỗi. KHÔNG đụng breaker đang `open` (kết quả về muộn
   * của lượt nhận trước khi mở — không được đóng sớm breaker đã mở vì hết ngân sách/lỗi). Trả true nếu vừa đóng từ
   * `half_open`.
   */
  async recordJobBreakerSuccess(key: string): Promise<boolean> {
    const rows = await this.exec(
      `WITH prev AS (
         SELECT id, state FROM job_breaker
         WHERE breaker_key = ?
           AND (state = 'half_open' OR (state = 'closed' AND (consecutive_failures > 0 OR last_failed_event_id IS NOT NULL)))
         FOR UPDATE)
       UPDATE job_breaker b SET state = 'closed', consecutive_failures = 0, last_failed_event_id = NULL,
              open_until = NULL, probe_until = NULL, updated_at = now()
       FROM prev WHERE b.id = prev.id AND b.state IN ('closed', 'half_open')
       RETURNING prev.state AS was`,
      [key],
    );
    return rows[0]?.was === "half_open";
  }

  /**
   * Mở breaker tới `openUntil` nếu đang ở một trong `from` (không có dòng = `closed`). Trả true = câu này vừa mở (đúng
   * một bản sao thắng → đúng một ngoại lệ/log mỗi lần mở).
   */
  async tripJobBreaker(
    key: string,
    reason: JobBreakerTripReason,
    openUntil: Date,
    from: readonly ("closed" | "half_open")[],
  ): Promise<boolean> {
    const fromClosed = from.includes("closed");
    const fromHalfOpen = from.includes("half_open");
    // Không có dòng = closed: tạo dòng closed trước (không đổi ngữ nghĩa) để câu chuyển trạng thái dưới đây có dòng để khoá.
    if (fromClosed) {
      await this.exec(
        `INSERT INTO job_breaker (id, breaker_key) VALUES (?, ?) ON CONFLICT (breaker_key) DO NOTHING`,
        [generateEntityId(undefined, "jbr"), key],
      );
    }
    const rows = await this.exec(
      `UPDATE job_breaker SET state = 'open', open_until = ?, probe_until = NULL, trip_reason = ?,
              trip_count = trip_count + 1, updated_at = now()
       WHERE breaker_key = ?
         AND ((state = 'closed' AND ?::boolean) OR (state = 'half_open' AND ?::boolean))
       RETURNING id`,
      [openUntil, reason, key, fromClosed, fromHalfOpen],
    );
    return rows.length === 1;
  }

  /* ------------------------------------------------------------ đơn sau mua (T-021) */

  /**
   * Tăng bộ đếm của `bucket` trong cửa sổ cố định chứa `now` và trả số đếm SAU khi tăng cùng số đếm của cửa sổ liền
   * trước — một câu (UPSERT … RETURNING trong CTE + đọc cửa sổ trước trên cùng snapshot) nên nhiều instance/request đồng
   * thời vẫn đếm đúng (AT20) và hai số đọc nhất quán. Quyết định chặn theo xấp xỉ cửa sổ trượt
   * (lib/security/sliding-window.ts, T-055) do bên gọi làm; `now` do bên gọi tiêm (test tất định) và đi kèm mẫu qua
   * `elapsedMs` — quyết định không đọc lại đồng hồ.
   */
  async hitRateCounter(bucket: string, windowMs: number, now: Date): Promise<WindowSample> {
    const start = windowStartMs(windowMs, now.getTime());
    const rows = await this.exec(
      `WITH hit AS (
         INSERT INTO rate_limit_counter (id, bucket, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limit_counter.count + 1, updated_at = now()
         RETURNING count
       )
       SELECT hit.count AS current,
              COALESCE((SELECT p.count FROM rate_limit_counter p WHERE p.bucket = ? AND p.window_start = ?), 0)
                AS previous
       FROM hit`,
      [generateEntityId(undefined, "rlc"), bucket, new Date(start), bucket, new Date(start - windowMs)],
    );
    return sampleAt(
      { current: Number(rows[0]?.current ?? 0), previous: Number(rows[0]?.previous ?? 0) },
      windowMs,
      now,
    );
  }

  /** Đọc (không tăng) số đếm cửa sổ hiện tại + cửa sổ trước trong một câu — dùng cho giới hạn chỉ đếm lần thất bại. */
  async peekRateCounter(bucket: string, windowMs: number, now: Date): Promise<WindowSample> {
    const start = windowStartMs(windowMs, now.getTime());
    const cur = new Date(start);
    const prev = new Date(start - windowMs);
    const rows = await this.exec(
      `SELECT COALESCE(SUM(count) FILTER (WHERE window_start = ?), 0) AS current,
              COALESCE(SUM(count) FILTER (WHERE window_start = ?), 0) AS previous
       FROM rate_limit_counter WHERE bucket = ? AND window_start IN (?, ?)`,
      [cur, prev, bucket, cur, prev],
    );
    return sampleAt(
      { current: Number(rows[0]?.current ?? 0), previous: Number(rows[0]?.previous ?? 0) },
      windowMs,
      now,
    );
  }

  /** Đánh dấu token tra cứu đã đổi thành phiên. false = token đã được dùng (UNIQUE token_hash). */
  async redeemOrderAccessToken(tokenHash: string, orderId: string, expiresAt: Date): Promise<boolean> {
    const rows = await this.exec(
      `INSERT INTO order_access_redemption (id, token_hash, order_id, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (token_hash) DO NOTHING RETURNING id`,
      [generateEntityId(undefined, "oacr"), tokenHash, orderId, expiresAt],
    );
    return rows.length === 1;
  }

  /**
   * Dọn bộ đếm cửa sổ cũ và dấu đổi token đã hết hạn (token hết hạn không còn đổi được nên dấu không cần nữa).
   * `webhookWindows`: chính sách webhook (tên → windowMs) — hàng `webhook.<tên>:%` chỉ cần giữ 2×windowMs (cửa sổ hiện
   * tại + trước), dọn sớm thay vì 2 ngày; bucket khác giữ 2 ngày.
   */
  async purgeOrderAccessRecords(
    now: Date,
    webhookWindows: Readonly<Record<string, number>> = {},
  ): Promise<{ counters: number; redemptions: number }> {
    let purged = 0;
    for (const [name, windowMs] of Object.entries(webhookWindows)) {
      if (!/^[A-Za-z0-9]+$/.test(name) || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
        throw new RangeError(`Chính sách webhook không hợp lệ: ${name}`);
      }
      const rows = await this.exec(
        `DELETE FROM rate_limit_counter WHERE bucket LIKE ? AND window_start < ? RETURNING id`,
        [`webhook.${name}:%`, new Date(now.getTime() - 2 * windowMs)],
      );
      purged += rows.length;
    }
    const counters = await this.exec(`DELETE FROM rate_limit_counter WHERE window_start < ? RETURNING id`, [
      new Date(now.getTime() - 2 * 24 * 3600_000),
    ]);
    const redemptions = await this.exec(
      `DELETE FROM order_access_redemption WHERE expires_at < ? RETURNING id`,
      [new Date(now.getTime() - 24 * 3600_000)],
    );
    return { counters: purged + counters.length, redemptions: redemptions.length };
  }

  /** Tổng ledger của đơn (dạng LedgerEntry của domain). */
  async ledgerEntriesOf(orderId: string, em?: SqlEntityManager): Promise<LedgerEntry[]> {
    const rows = await this.exec(
      `SELECT kind, amount, provider_txn_id, refund_id, state FROM payment_ledger
       WHERE order_id = ? AND deleted_at IS NULL`,
      [orderId],
      em,
    );
    return rows.map((r) =>
      r.kind === "capture"
        ? { kind: "capture", amount: Number(r.amount), providerTxnId: String(r.provider_txn_id) }
        : {
            kind: "refund",
            amount: Number(r.amount),
            refundId: String(r.refund_id ?? ""),
            state: String(r.state) as RefundState,
          },
    );
  }

  /**
   * Khách hủy đơn (POST02, S-309) — MỘT transaction, chỉ khi đơn còn ở `from` (khóa lạc quan theo trạng thái):
   * order_finance → cancelled, payment attempt mở → failed, lượt mã (held/used) → released, checkout attempt → failed
   * (nhả phiên bản giỏ), outbox `order.cancelled`; đơn đã thu tiền (`refund_amount` > 0) → ngoại lệ `refund_request`
   * (hoàn thật + hủy native ở T-027). Trả false nếu đơn đã rời `from` (nhánh khác thắng). `reason`: khách tự hủy
   * (mặc định) hay cửa hàng hủy (nhân viên `order.cancel` — T-044).
   */
  async cancelOrderByCustomer(input: {
    order_id: string;
    from: OrderState;
    refund_amount: number;
    display_ref: string;
    now: Date;
    reason?: "CUSTOMER_CANCELLED" | "SHOP_CANCELLED";
  }): Promise<boolean> {
    const reason = input.reason ?? "CUSTOMER_CANCELLED";
    const t = orderMachine.transition(input.from, "cancelled");
    if (!t.ok) return false;
    return this.repo_.transaction(async (em) => {
      const fin = await this.exec(
        `UPDATE order_finance SET state = 'cancelled', version = version + 1, updated_at = now()
         WHERE order_id = ? AND state = ? RETURNING id`,
        [input.order_id, input.from],
        em,
      );
      if (fin.length !== 1) return false;
      await this.exec(
        `UPDATE payment_attempt SET state = 'failed', updated_at = now()
         WHERE order_id = ? AND state IN ('created', 'pending', 'unknown')`,
        [input.order_id],
        em,
      );
      await this.exec(
        `UPDATE coupon_usage SET state = 'released', updated_at = now()
         WHERE order_id = ? AND state IN ('held', 'used')`,
        [input.order_id],
        em,
      );
      await this.exec(
        `UPDATE checkout_attempt SET state = 'failed', error_code = ?, updated_at = now()
         WHERE order_id = ? AND state = 'ready'`,
        [reason, input.order_id],
        em,
      );
      await this.insertOutbox(
        `order.cancelled:${input.order_id}`,
        input.order_id,
        "order.cancelled",
        {
          order_id: input.order_id,
          reason,
          from: input.from,
          refund_amount: input.refund_amount,
        },
        em,
      );
      if (input.refund_amount > 0) {
        await this.openOpsException(
          {
            kind: "refund_request",
            dedupe_key: `refund_request:${input.order_id}`,
            order_id: input.order_id,
            amount: input.refund_amount,
            priority: "high",
            due_at: new Date(input.now.getTime() + 24 * 3600_000),
            detail: {
              reason,
              display_ref: input.display_ref,
              order_state_before: input.from,
              native_cancel_pending: true,
            },
          },
          em,
        );
      }
      return true;
    });
  }

  async insertOutbox(
    eventKey: string,
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    em?: SqlEntityManager,
    nextAttemptAt: Date | null = null,
  ): Promise<void> {
    const body = outboxJson(type, payload);
    await this.exec(
      `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, next_attempt_at)
       VALUES (?, ?, ?, ?, ?::jsonb, 'pending', COALESCE(?, now()))
       ON CONFLICT (event_key) DO NOTHING`,
      [generateEntityId(undefined, "obx"), eventKey, aggregateId, type, body, nextAttemptAt],
      em,
    );
  }
}

/** Postgres unique_violation (23505), có thể đã được MikroORM/Medusa bọc. */
export function isUniqueViolation(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (typeof cur === "object" && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (o.code === "23505" || /UniqueConstraintViolation/.test(String(o.name))) return true;
    cur = o.cause ?? o.previous;
  }
  return false;
}

export default CheckoutModuleService;
