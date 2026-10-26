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

export type OutboxHandler = (container: MedusaContainer, event: OutboxClaim) => Promise<void>;

export const OUTBOX_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 10_000,
  maxDelayMs: 3600_000,
  /** Thời gian một dispatcher giữ sự kiện đã nhận trước khi dispatcher khác được nhận lại. */
  claimLeaseMs: 60_000,
} as const;

/** Lũy thừa: 10s, 20s, 40s… tối đa 1 giờ (lần thử thứ n đã hỏng). */
export function outboxBackoffMs(failedAttempts: number): number {
  return Math.min(OUTBOX_POLICY.baseDelayMs * 2 ** Math.max(0, failedAttempts - 1), OUTBOX_POLICY.maxDelayMs);
}

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
}

export async function dispatchOutbox(
  container: MedusaContainer,
  opts: { now?: Date; limit?: number; handlers?: Record<string, OutboxHandler> } = {},
): Promise<DispatchSummary> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const handlers = { ...DEFAULT_OUTBOX_HANDLERS, ...opts.handlers };
  const summary: DispatchSummary = { sent: [], retried: [], dead: [] };
  for (let i = 0; i < (opts.limit ?? 100); i++) {
    const event = await s.claimDueOutbox(now, OUTBOX_POLICY.claimLeaseMs);
    if (!event) break;
    try {
      await (handlers[event.type] ?? logHandler)(container, event);
      await s.markOutboxSent(event.id);
      summary.sent.push(event.event_key);
    } catch (e) {
      const failed = event.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      if (failed >= OUTBOX_POLICY.maxAttempts) {
        await s.markOutboxFailed(event.id, message, null);
        // Thông báo khách hỏng → ngoại lệ riêng cho người theo dõi gửi tin (AT18); đơn không bị ảnh hưởng.
        const kind = isNotificationEvent(event.type) ? "notification_failed" : "outbox_dead";
        await s.openOpsException({
          kind,
          dedupe_key: `${kind}:${event.event_key}`,
          order_id: event.aggregate_id.startsWith("order_") ? event.aggregate_id : null,
          priority: "high",
          detail: { event_key: event.event_key, type: event.type, last_error: message.slice(0, 500) },
        });
        summary.dead.push(event.event_key);
      } else {
        await s.markOutboxFailed(event.id, message, new Date(now.getTime() + outboxBackoffMs(failed)));
        summary.retried.push(event.event_key);
      }
    }
  }
  return summary;
}
