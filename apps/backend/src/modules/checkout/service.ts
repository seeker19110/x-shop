import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/knex";
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
  OPS_EXCEPTION_KINDS,
  type PaymentMethod,
} from "./models/constants";
import {
  CartVersion,
  CheckoutAttempt,
  CheckoutQuote,
  CouponUsage,
  OpsException,
  OrderFinance,
  OutboxEvent,
  PaymentAttempt,
  PaymentLedger,
  WebhookInbox,
} from "./models/checkout-models";

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

export type CaptureOutcome =
  { duplicate: true } | { duplicate: false; decision: CaptureDecision; state_before: OrderState };

const json = (value: unknown) => JSON.stringify(value ?? null);

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
}) {
  protected readonly repo_: BaseRepositoryLike;

  constructor(container: { baseRepository: BaseRepositoryLike }, ...rest: unknown[]) {
    super(container, ...rest);
    this.repo_ = container.baseRepository;
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
          json(input.outbox.payload),
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
      result: row.processed_at ? ((row.result as Record<string, unknown> | null) ?? null) : null,
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

  /** Đánh dấu sự kiện outbox đã xong khi việc của nó đã được làm ngay (không chờ dispatcher). */
  async markOutboxSentByKey(eventKey: string): Promise<void> {
    await this.exec(
      `UPDATE outbox_event SET state = 'sent', updated_at = now() WHERE event_key = ? AND state IN ('pending', 'failed')`,
      [eventKey],
    );
  }

  async insertOutbox(
    eventKey: string,
    aggregateId: string,
    type: string,
    payload: Record<string, unknown>,
    em?: SqlEntityManager,
  ): Promise<void> {
    await this.exec(
      `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, next_attempt_at)
       VALUES (?, ?, ?, ?, ?::jsonb, 'pending', now())
       ON CONFLICT (event_key) DO NOTHING`,
      [generateEntityId(undefined, "obx"), eventKey, aggregateId, type, json(payload)],
      em,
    );
  }
}

/** Postgres unique_violation (23505), có thể đã được MikroORM/Medusa bọc. */
export function isUniqueViolation(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (o.code === "23505" || /UniqueConstraintViolation/.test(String(o.name))) return true;
    cur = o.cause ?? o.previous;
  }
  return false;
}

export default CheckoutModuleService;
