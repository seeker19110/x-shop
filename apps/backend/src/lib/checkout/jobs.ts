import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { cancelOrderWorkflow, deleteReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { OutboxClaim } from "../../modules/checkout/service";
import { CHECKOUT_CONFIG } from "./config";
import { readCheckoutError } from "./errors";
import { acquireOrdered, lockKeys, releaseOwnedOrWarn } from "./locks";
import { isNotificationEvent, notificationHandler, NOTIFICATION_EVENT_TYPES } from "../notify/notify";
import { syncNativePayment } from "./payment";
import { queryAndProcess } from "./recheck";
import { validateOutboxPayload } from "../outbox/payload";
import { OUTBOX_POLICY, outboxBackoffMs, outboxNextDelayMs } from "../outbox/policy";
import { retryInfoOf, type Random } from "../outbox/retry";
import {
  assertBreakerPolicy,
  BreakerRun,
  breakerKeyOf,
  OUTBOX_BREAKER_POLICY,
  OUTBOX_RUN_LIMITS,
  type BreakerTrip,
  type OutboxBreakerPolicy,
  type OutboxRunLimits,
} from "../outbox/breaker";

/**
 * Hàm xử lý của các job worker (docs/design/checkout-flow.md §6). Tách khỏi `src/jobs/*` để test gọi trực tiếp với
 * `now` tùy ý (không chờ cron). Mọi thay đổi trạng thái đơn chạy dưới khóa `order:<id>` và kiểm lại trạng thái sau khi
 * có khóa → chạy song song/lặp lại vẫn đúng một kết cục (S-005, S-006, AT12).
 */
const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
const logger = (c: MedusaContainer) => c.resolve(ContainerRegistrationKeys.LOGGER);

async function withLock<T>(
  container: MedusaContainer,
  key: string,
  waitMs: number,
  scope: string,
  fn: () => Promise<T>,
): Promise<T | "busy"> {
  const locking = container.resolve(Modules.LOCKING);
  const owner = `job:${randomUUID()}`;
  try {
    await acquireOrdered(locking, [key], {
      ownerId: owner,
      waitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope,
    });
  } catch (e) {
    if (readCheckoutError(e)?.code === "BUSY_RETRY") return "busy";
    throw e;
  }
  try {
    return await fn();
  } finally {
    await releaseOwnedOrWarn(locking, owner, logger(container), "job");
  }
}

/** Hủy đơn native (idempotent): đã canceled → bỏ qua. cancelOrderWorkflow xoá reservation theo line item của đơn. */
export async function cancelNativeOrder(container: MedusaContainer, orderId: string): Promise<void> {
  const order = await container.resolve(Modules.ORDER).retrieveOrder(orderId);
  if (order.status === "canceled") return;
  await cancelOrderWorkflow(container).run({ input: { order_id: orderId, canceled_by: "x-shop:job" } });
}

/* ---------------------------------------------------------------- expire-holds */

export interface ExpireSummary {
  cancelled: string[];
  confirmed: string[];
  unknown: string[];
  skipped: string[];
}

/**
 * Đơn `awaiting_payment` quá `hold_expires_at`: khóa đơn → querydr. paid → xử lý như IPN; chưa trả/thất bại → hủy
 * native (nhả reservation) + cancelled + mã released + attempt failed (đúng một lần); unknown → KHÔNG hủy, attempt
 * `unknown`, ngoại lệ payment_unknown hạn 30 phút (AT11).
 */
export async function expireHolds(
  container: MedusaContainer,
  opts: { now?: Date; limit?: number } = {},
): Promise<ExpireSummary> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const summary: ExpireSummary = { cancelled: [], confirmed: [], unknown: [], skipped: [] };
  for (const orderId of await s.listExpiredHoldOrderIds(now, opts.limit ?? 100)) {
    const outcome = await withLock(
      container,
      lockKeys.order(orderId),
      CHECKOUT_CONFIG.orderLockWaitMs,
      "order",
      () => expireOne(container, orderId, now),
    );
    summary[outcome === "busy" ? "skipped" : outcome].push(orderId);
  }
  return summary;
}

async function expireOne(
  container: MedusaContainer,
  orderId: string,
  now: Date,
): Promise<"cancelled" | "confirmed" | "unknown" | "skipped"> {
  const s = service(container);
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  // Kiểm lại SAU khi có khóa: IPN/lượt expiry khác có thể đã xử lý.
  if (
    !fin ||
    fin.state !== "awaiting_payment" ||
    !fin.hold_expires_at ||
    new Date(fin.hold_expires_at) > now
  ) {
    return "skipped";
  }
  const q = await queryAndProcess(container, orderId, { orderLockHeld: true });
  if (q.outcome === "paid") {
    const [after] = await s.listOrderFinances({ order_id: orderId });
    return after?.state === "confirmed" ? "confirmed" : "skipped";
  }
  if (q.outcome === "unknown") {
    const [pa] = await s.listPaymentAttempts({ order_id: orderId, state: ["created", "pending", "unknown"] });
    if (pa) await s.movePaymentAttempt(pa.id, "unknown");
    await s.openOpsException({
      kind: "payment_unknown",
      dedupe_key: `payment_unknown:${orderId}:${pa?.id ?? "none"}`,
      order_id: orderId,
      amount: fin.total,
      priority: "high",
      due_at: new Date(now.getTime() + CHECKOUT_CONFIG.paymentUnknownDueMs),
      detail: { reason: q.reason, txn_ref: pa?.txn_ref ?? null, source: "expire-holds" },
    });
    return "unknown";
  }
  // not_paid | failed | skipped (không còn attempt mở) → hủy. Native trước (idempotent), rồi chốt trạng thái module:
  // chết giữa chừng thì lần chạy sau thấy đơn vẫn awaiting_payment và làm lại an toàn.
  await cancelNativeOrder(container, orderId);
  return (await s.cancelExpiredOrder(orderId, "HOLD_EXPIRED")) ? "cancelled" : "skipped";
}

/* ---------------------------------------------------------------- reconcile-attempts */

export interface ReconcileSummary {
  compensated: string[];
  skipped: string[];
}

/** Đơn native do một attempt tạo (metadata.x_checkout_attempt_id) — đọc thẳng bảng order (chỉ đọc, cùng DB). */
async function ordersOfAttempt(container: MedusaContainer, attemptId: string): Promise<string[]> {
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const res = await pg.raw(
    `SELECT id FROM "order" WHERE metadata->>'x_checkout_attempt_id' = ? AND deleted_at IS NULL`,
    [attemptId],
  );
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

/** Mô tả reservation do submit tạo (workflows/checkout/submit-checkout.ts) — tìm lại được cả khi đơn native đã bị xoá. */
export const attemptReservationDescription = (attemptId: string) => `checkout ${attemptId}`;

/**
 * Phần dở còn lại của một attempt: đơn native chưa xoá + reservation của nó. Reservation tìm theo dòng đơn VÀ theo mô tả
 * `checkout <id>`: bù trừ có thể đã xoá đơn nhưng không xoá được reservation (khóa native cần Redis — T-042).
 */
export async function leftoversOfAttempt(
  container: MedusaContainer,
  attemptId: string,
): Promise<{ orderIds: string[]; reservationIds: string[] }> {
  const orderIds = await ordersOfAttempt(container, attemptId);
  const inventory = container.resolve(Modules.INVENTORY);
  const ids = new Set<string>();
  if (orderIds.length > 0) {
    const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: "order",
      fields: ["id", "items.id"],
      filters: { id: orderIds },
    });
    const lineIds = (data as Array<{ items?: Array<{ id: string } | null> }>).flatMap((o) =>
      (o.items ?? []).flatMap((i) => (i ? [i.id] : [])),
    );
    if (lineIds.length > 0) {
      for (const r of await inventory.listReservationItems({ line_item_id: lineIds })) ids.add(r.id);
    }
  }
  for (const r of await inventory.listReservationItems({
    description: attemptReservationDescription(attemptId),
  })) {
    ids.add(r.id);
  }
  return { orderIds, reservationIds: [...ids] };
}

/**
 * Attempt `preparing` quá lease (tiến trình submit đã chết — AT10): lấy khóa giỏ (submit còn sống thì đang giữ → bỏ
 * qua), nhận quyền bù trừ, rồi nhả reservation đã tạo, hủy đơn native, mã → released, order_finance → cancelled.
 */
export async function reconcileAttempts(
  container: MedusaContainer,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const summary: ReconcileSummary = { compensated: [], skipped: [] };
  for (const a of await s.listStaleAttempts(now, opts.limit ?? 50)) {
    const outcome = await withLock(container, lockKeys.cart(a.cart_id), 1_000, "cart", async () => {
      if (!(await s.claimStaleAttempt(a.id, now))) return "skipped" as const;
      const { orderIds, reservationIds } = await leftoversOfAttempt(container, a.id);
      if (reservationIds.length > 0) {
        await deleteReservationsWorkflow(container).run({ input: { ids: reservationIds } });
      }
      for (const id of orderIds) await cancelNativeOrder(container, id);
      await s.compensateAttemptRecords(a.id, orderIds);
      return "compensated" as const;
    });
    summary[outcome === "busy" ? "skipped" : outcome].push(a.id);
  }
  return summary;
}

/* ---------------------------------------------------------------- cod-confirm-timeout */

/** Đơn COD quá hạn xác nhận → ngoại lệ cho nhân viên đơn (KHÔNG tự hủy — §6.3). Mỗi đơn một ngoại lệ. */
export async function codConfirmTimeout(
  container: MedusaContainer,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ opened: string[] }> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const opened: string[] = [];
  for (const o of await s.listOverdueCodOrders(now, opts.limit ?? 200)) {
    const isNew = await s.openOpsException({
      kind: "cod_confirm_overdue",
      dedupe_key: `cod_confirm_overdue:${o.order_id}`,
      order_id: o.order_id,
      priority: "high",
      due_at: new Date(now.getTime() + 4 * 3600_000),
      detail: { display_ref: o.display_ref, owner_role: "order_staff" },
    });
    if (isNew) opened.push(o.order_id);
  }
  return { opened };
}

/* ---------------------------------------------------------------- outbox-dispatch */

/**
 * Ngữ cảnh một lần xử lý: `now` = thời điểm xử lý sự kiện theo đồng hồ của dispatcher (`opts.now`, không thì `clock()`
 * lúc gọi bộ xử lý) — bộ xử lý cần giờ (vd. hạn token liên kết tính từ LÚC GỬI, T-149) dùng giá trị này để test tiêm được.
 */
export interface OutboxHandlerContext {
  now: Date;
}

export type OutboxHandler = (
  container: MedusaContainer,
  event: OutboxClaim,
  ctx: OutboxHandlerContext,
) => Promise<void>;

// Chính sách retry outbox (hàm thuần) ở lib/outbox/policy — giữ export cũ cho caller/test.
export { OUTBOX_POLICY, outboxBackoffMs, outboxNextDelayMs };

/** Bộ xử lý mặc định. Thông báo khách (email/SMS) đi qua `lib/notify` (T-029) theo message key duy nhất. */
export const DEFAULT_OUTBOX_HANDLERS: Record<string, OutboxHandler> = {
  ...Object.fromEntries(NOTIFICATION_EVENT_TYPES.map((t) => [t, notificationHandler] as const)),
  "payment.native_sync": async (container, event) => {
    const orderId = String(event.payload.order_id ?? event.aggregate_id);
    const r = await withLock(
      container,
      lockKeys.order(orderId),
      CHECKOUT_CONFIG.orderLockWaitMs,
      "order",
      () => syncNativePayment(container, orderId),
    );
    if (r === "busy") throw new Error("đơn đang bận");
  },
};

const logHandler: OutboxHandler = async (container, event) => {
  logger(container).info(`[outbox] ${event.type} ${event.event_key} (không có bộ xử lý — chỉ ghi log)`);
};

export interface DispatchSummary {
  sent: string[];
  retried: string[];
  dead: string[];
  /** Hoãn không thử vì circuit breaker mở/đang thử/bóp (T-097) — vẫn trong outbox, `attempts` không đổi. */
  deferred: string[];
  /** Lượt chạy dừng sớm vì chạm trần lượt gọi (`OUTBOX_RUN_LIMITS.maxCalls`); null = không. */
  stopped: "max_calls" | null;
}

/** Vì sao sự kiện vào `dead` (ghi vào ngoại lệ — không PII). */
export type DeadReason = "invalid_payload" | "permanent_error" | "max_attempts";

/** Kind ngoại lệ khi circuit breaker job nền mở (T-097) — một ngoại lệ đang mở mỗi breaker. */
export const JOB_CIRCUIT_OPEN_KIND = "job_circuit_open";

/**
 * Breaker vừa mở (bản sao này thắng câu chuyển trạng thái) → ngoại lệ vận hành `job_circuit_open`, dedupe theo breaker
 * đang mở (`openOpsExceptionIfNoneActive`, phạm vi `breaker`). Chỉ khoá breaker + số liệu — không PII, không thông điệp
 * lỗi. Mở lỗi → log, không ném (breaker đã mở; ngoại lệ không được làm sập lượt chạy).
 */
async function openBreakerException(container: MedusaContainer, trip: BreakerTrip): Promise<void> {
  try {
    await service(container).openOpsExceptionIfNoneActive({
      kind: JOB_CIRCUIT_OPEN_KIND,
      dedupe_key: `${JOB_CIRCUIT_OPEN_KIND}:${randomUUID()}`,
      priority: "high",
      detail: {
        breaker: trip.key,
        reason: trip.reason,
        open_until: trip.openUntil.toISOString(),
        ...(trip.consecutiveFailures !== undefined && { consecutive_failures: trip.consecutiveFailures }),
        ...(trip.budgetLimit !== undefined && {
          budget_used: trip.budgetUsed,
          budget_limit: trip.budgetLimit,
        }),
      },
      active_scope: ["breaker"],
    });
  } catch (e) {
    logger(container).error(
      `[breaker] Không mở được ngoại lệ ${JOB_CIRCUIT_OPEN_KIND} cho ${trip.key}: ${e instanceof Error ? e.name : "lỗi"}`,
    );
  }
}

/**
 * Gửi sự kiện outbox đến hạn. Trần mỗi lượt chạy + circuit breaker chi phí theo adapter (lib/outbox/breaker.ts, T-097):
 * breaker mở/đang thử/bóp → hoãn sự kiện (`deferOutbox`, không tăng `attempts`), không gọi dịch vụ ngoài. Sự kiện không
 * có bộ xử lý (chỉ ghi log) không gọi gì bên ngoài nên không qua breaker.
 */
export async function dispatchOutbox(
  container: MedusaContainer,
  opts: {
    now?: Date;
    /** Số vòng tối đa của lượt này — kẹp trong trần `runLimits.maxIterations`. */
    limit?: number;
    handlers?: Record<string, OutboxHandler>;
    /** RNG cho jitter (test tiêm để tất định). */
    random?: Random;
    /** Đồng hồ khi không tiêm `now` (mặc định giờ thật) — test tiêm để mô phỏng lượt chạy dài. */
    clock?: () => Date;
    /** Chính sách breaker/trần lượt chạy (test tiêm ngưỡng nhỏ); mặc định `OUTBOX_BREAKER_POLICY`/`OUTBOX_RUN_LIMITS`. */
    breakerPolicy?: OutboxBreakerPolicy;
    runLimits?: OutboxRunLimits;
  } = {},
): Promise<DispatchSummary> {
  const clock = opts.clock ?? (() => new Date());
  const now = opts.now ?? clock();
  const s = service(container);
  const handlers = { ...DEFAULT_OUTBOX_HANDLERS, ...opts.handlers };
  const summary: DispatchSummary = { sent: [], retried: [], dead: [], deferred: [], stopped: null };
  const policy = opts.breakerPolicy ?? OUTBOX_BREAKER_POLICY;
  const limits = opts.runLimits ?? OUTBOX_RUN_LIMITS;
  if (opts.breakerPolicy || opts.runLimits) assertBreakerPolicy(policy, limits);
  const log = logger(container);
  const breaker = new BreakerRun(s, policy, {
    onTrip: (trip) => openBreakerException(container, trip),
    warn: (m) => log.warn(m),
    info: (m) => log.info(m),
  });

  const markDead = async (event: OutboxClaim, message: string, reason: DeadReason) => {
    await s.markOutboxFailed(event.id, message, null);
    // Thông báo khách hỏng → ngoại lệ riêng cho người theo dõi gửi tin (AT18); đơn không bị ảnh hưởng.
    const kind = isNotificationEvent(event.type) ? "notification_failed" : "outbox_dead";
    await s.openOpsException({
      kind,
      dedupe_key: `${kind}:${event.event_key}`,
      order_id: event.aggregate_id.startsWith("order_") ? event.aggregate_id : null,
      priority: "high",
      detail: {
        event_key: event.event_key,
        type: event.type,
        dead_reason: reason,
        attempts: event.attempts + 1,
        last_error: message.slice(0, 500),
      },
    });
    summary.dead.push(event.event_key);
  };

  const iterations = Math.min(opts.limit ?? limits.maxIterations, limits.maxIterations);
  for (let i = 0; i < iterations; i++) {
    // Trần lượt gọi: xét TRƯỚC khi nhận — không giữ sự kiện nào mà không xử lý.
    if (breaker.calls >= limits.maxCalls) {
      summary.stopped = "max_calls";
      log.info(`[outbox] Chạm trần ${limits.maxCalls} lượt gọi/lượt chạy — phần còn lại chờ lượt sau`);
      break;
    }
    const event = await s.claimDueOutbox(now, OUTBOX_POLICY.claimLeaseMs);
    if (!event) break;
    // Payload kiểm khi NHẬN (BE-JOB-007): sai schema là lỗi vĩnh viễn → dead ngay kèm lý do, lượt chạy tiếp tục.
    const check = validateOutboxPayload(event.type, event.payload);
    if (!check.ok) {
      await markDead(event, check.reason, "invalid_payload");
      continue;
    }
    const handler = handlers[event.type];
    const key = breakerKeyOf(event.type);
    if (handler) {
      const admission = await breaker.admit(key, opts.now ?? clock());
      if (admission.kind === "defer") {
        await s.deferOutbox(event.id, admission.until);
        summary.deferred.push(event.event_key);
        continue;
      }
    }
    let ok = false;
    try {
      await (handler ?? logHandler)(container, event, { now: opts.now ?? clock() });
      await s.markOutboxSent(event.id);
      summary.sent.push(event.event_key);
      ok = true;
    } catch (e) {
      const failed = event.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      const info = retryInfoOf(e);
      // Hẹn tính từ LÚC LỖI (không phải đầu lượt): lượt dài vẫn chờ đủ Retry-After/backoff. `now` tiêm → mốc cố định.
      const failedAt = opts.now ?? clock();
      if (info.permanent) {
        // 4xx nghiệp vụ / validate: thử lại không đổi được kết quả → DLQ ngay (BE-JOB-003).
        await markDead(event, message, "permanent_error");
      } else {
        if (failed >= OUTBOX_POLICY.maxAttempts) {
          await markDead(event, message, "max_attempts");
        } else {
          const delay = outboxNextDelayMs(failed, info.retryAfterMs, opts.random);
          await s.markOutboxFailed(event.id, message, new Date(failedAt.getTime() + delay));
          summary.retried.push(event.event_key);
        }
        // Lỗi tạm = tín hiệu sức khoẻ adapter (lỗi vĩnh viễn không — đó là lỗi của riêng sự kiện).
        if (handler) await breaker.onFailure(key, event.id, failedAt);
      }
    }
    if (ok && handler) await breaker.onSuccess(key);
  }
  return summary;
}
