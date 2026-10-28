import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { cancelOrderWorkflow, deleteReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { JobBreakerSnapshot, OutboxClaim } from "../../modules/checkout/service";
import { isDraining } from "../lifecycle/shutdown";
import { CHECKOUT_CONFIG } from "./config";
import { HOLD_RECHECK_POLICY, holdRecheckAt, holdRecheckDelayMs } from "./hold-recheck";
import { readCheckoutError } from "./errors";
import { acquireOrdered, lockKeys, releaseOwnedOrWarn } from "./locks";
import { isNotificationEvent, notificationHandler, NOTIFICATION_EVENT_TYPES } from "../notify/notify";
import { syncNativePayment } from "./payment";
import { CATALOG_REVALIDATE_EVENT, catalogRevalidateHandler } from "../catalog/revalidate";
import { queryAndProcess, type QueryGate } from "./recheck";
import { validateOutboxPayload } from "../outbox/payload";
import { OUTBOX_POLICY, outboxBackoffMs, outboxNextDelayMs } from "../outbox/policy";
import { retryInfoOf, type Random } from "../outbox/retry";
import {
  assertBreakerPolicy,
  BreakerRun,
  breakerKeyOf,
  OUTBOX_BREAKER_POLICY,
  OUTBOX_RUN_LIMITS,
  subBudgetOf,
  VNPAY_QUERYDR_BREAKER_KEY,
  type BreakerTrip,
  type OutboxBreakerPolicy,
  type OutboxRunLimits,
} from "../outbox/breaker";
import { hoursToMs, secondsToMs } from "@x-shop/domain";

/**
 * Hàm xử lý của các job worker (docs/design/checkout-flow.md §6). Tách khỏi `src/jobs/*` để test gọi trực tiếp với
 * `now` tùy ý (không chờ cron). Mọi thay đổi trạng thái đơn chạy dưới khóa `order:<id>` và kiểm lại trạng thái sau khi
 * có khóa → chạy song song/lặp lại vẫn đúng một kết cục (S-005, S-006, AT12).
 */
const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
const logger = (c: MedusaContainer) => c.resolve(ContainerRegistrationKeys.LOGGER);

/** Hạn xử lý ngoại lệ "đơn COD quá hạn xác nhận": 4 giờ kể từ lúc mở. */
export const COD_OVERDUE_EXCEPTION_DUE_MS = hoursToMs(4);
/** Chờ khoá giỏ tối đa 1 giây khi bù trừ attempt `preparing` quá hạn (lượt sau thử lại). */
export const STALE_ATTEMPT_LOCK_WAIT_MS = secondsToMs(1);

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
      abortWhenDraining: true,
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
  /**
   * Không gọi querydr vì breaker `vnpay.querydr` mở/đang thử/bóp (T-161): xử lý NHƯ `unknown` (giữ hàng, attempt
   * `unknown`, ngoại lệ payment_unknown lý do `breaker_<lý do hoãn>`) — không hủy, không nhả; lượt sau khi breaker đóng hỏi lại.
   */
  deferred: string[];
  skipped: string[];
  /** Lượt chạy dừng ở ranh giới giữa hai đơn vì tiến trình đang tắt (T-172/D-081); đơn chưa xét để nguyên cho lượt sau. */
  stopped: "draining" | null;
  /**
   * Sau lượt chạy: số đơn quá hạn còn `awaiting_payment` đã được xét mà chưa có kết cục — chưa rõ/lỗi
   * (`hold_check_attempts` ≥ 1) hoặc bị hoãn (`next_check_at` có giá trị) — tồn đọng đang giữ hàng; ≥ `HOLD_RECHECK_POLICY.backlogWarnAt` → log WARN (T-164, RUNBOOK §1).
   * Lượt dừng vì đang tắt (`stopped` ≠ null) KHÔNG đếm: giá trị 0 khi đó là "chưa đếm", không phải "hết tồn đọng" (T-172).
   */
  unknownBacklog: number;
}

/**
 * Kết quả querydr là lỗi TẠM của cổng (tín hiệu sức khoẻ cho breaker): hết giờ, lỗi mạng, adapter ném, HTTP 5xx/408/429.
 * Còn lại (mã trạng thái VNPAY, chữ ký/số tiền sai, HTTP 4xx khác) = cổng ĐÃ TRẢ LỜI → không phải lỗi của cổng (D-111).
 */
export function isTransientQueryFailure(reason: string): boolean {
  return (
    reason === "timeout" ||
    reason === "network" ||
    reason.startsWith("adapter_error:") ||
    /^http_(5\d\d|408|429)$/.test(reason)
  );
}

/**
 * Đơn `awaiting_payment` quá `hold_expires_at`: khóa đơn → querydr. paid → xử lý như IPN; chưa trả/thất bại → hủy
 * native (nhả reservation) + cancelled + mã released + attempt failed (đúng một lần); unknown → KHÔNG hủy, attempt
 * `unknown`, ngoại lệ payment_unknown hạn 30 phút (AT11).
 *
 * querydr đi qua circuit breaker `vnpay.querydr` (T-161, lib/outbox/breaker.ts — trạng thái dùng chung mọi bản sao):
 * cổng lỗi tạm liên tiếp → mở, các đơn còn lại KHÔNG gọi querydr mà xử lý như `unknown` (giữ hàng — không bán vượt, không
 * nhả hàng của đơn có thể đã trả tiền; mỗi đơn có ngoại lệ payment_unknown hạn 30 phút + một ngoại lệ job_circuit_open →
 * không giữ hàng âm thầm vô thời hạn). Đơn vẫn `awaiting_payment` quá hạn nên lượt chạy sau khi breaker đóng hỏi lại.
 * Lỗi DB của breaker → ném (fail-closed: không gọi, không hủy).
 *
 * Backoff theo đơn (T-164): chỉ xét đơn tới hạn kiểm lại (`next_check_at` NULL/≤ now), sắp theo hạn xét thực tế; đơn
 * `unknown`/lỗi hẹn lại 1 → 2 → 4 … → 60 phút, đơn bị hoãn lùi 1 phút → ≥ `limit` đơn chưa rõ kẹt không chặn đơn quá
 * hạn mới, querydr không bị gọi lặp mỗi phút cho cùng đơn. IPN không phụ thuộc lịch này.
 */
export async function expireHolds(
  container: MedusaContainer,
  opts: {
    now?: Date;
    limit?: number;
    /** Chính sách breaker (test tiêm ngưỡng nhỏ); mặc định `OUTBOX_BREAKER_POLICY`. */
    breakerPolicy?: OutboxBreakerPolicy;
    /** Ngưỡng log WARN tồn đọng đơn chưa rõ (test tiêm); mặc định `HOLD_RECHECK_POLICY.backlogWarnAt`. */
    backlogWarnAt?: number;
  } = {},
): Promise<ExpireSummary> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const summary: ExpireSummary = {
    cancelled: [],
    confirmed: [],
    unknown: [],
    deferred: [],
    skipped: [],
    stopped: null,
    unknownBacklog: 0,
  };
  const policy = opts.breakerPolicy ?? OUTBOX_BREAKER_POLICY;
  if (opts.breakerPolicy) assertBreakerPolicy(policy, OUTBOX_RUN_LIMITS);
  const log = logger(container);
  const breaker = new BreakerRun(s, policy, {
    onTrip: (trip) => openBreakerException(container, trip),
    warn: (m) => log.warn(m),
    info: (m) => log.info(m),
  });
  const due = await s.listExpiredHoldOrderIds(now, opts.limit ?? 100);
  const ordered = probeOrder(due, await s.readJobBreaker(VNPAY_QUERYDR_BREAKER_KEY));
  for (const orderId of ordered) {
    // Ranh giới giữa hai đơn (T-172/D-081): đang tắt → không bắt đầu đơn mới (querydr ≤ vài giây/đơn); đơn dở không bị ngắt.
    if (isDraining()) {
      summary.stopped = "draining";
      log.info("[expire-holds] Đang tắt — dừng ở ranh giới đơn, phần còn lại chờ lượt sau");
      break;
    }
    const outcome = await withLock(
      container,
      lockKeys.order(orderId),
      CHECKOUT_CONFIG.orderLockWaitMs,
      "order",
      () => expireOneWithBackoff(container, orderId, now, breaker),
    );
    summary[outcome === "busy" ? "skipped" : outcome].push(orderId);
  }
  // Đang tắt: bỏ đếm tồn đọng (thêm một truy vấn khi pool sắp đóng); lượt sau đếm (unknownBacklog = 0 nghĩa là "chưa đếm").
  if (summary.stopped !== null) return summary;
  summary.unknownBacklog = await s.countUnknownHoldBacklog(now);
  const warnAt = opts.backlogWarnAt ?? HOLD_RECHECK_POLICY.backlogWarnAt;
  if (summary.unknownBacklog >= warnAt) {
    log.warn(
      `[expire-holds] ${summary.unknownBacklog} đơn quá hạn chưa rõ thanh toán đang giữ hàng (ngưỡng ${warnAt}) — xem RUNBOOK §1`,
    );
  }
  return summary;
}

/**
 * `expireOne` + backoff theo đơn (T-164, lib/checkout/hold-recheck.ts) — chạy dưới khóa đơn. `unknown` → hẹn kiểm lại
 * theo hàm mũ có trần (tăng `hold_check_attempts`); `deferred` (breaker, không gọi querydr) → chỉ lùi 1 phút, không
 * tăng; lượt xử lý ném lỗi → hẹn như `unknown` (cố gắng hết sức) rồi NÉM LẠI (fail-closed như trước: lượt chạy dừng) — đơn
 * lỗi lặp không còn đứng đầu mọi lượt. Kết cục cuối (confirmed/cancelled) không cần hẹn: đơn rời `awaiting_payment`.
 */
async function expireOneWithBackoff(
  container: MedusaContainer,
  orderId: string,
  now: Date,
  breaker: BreakerRun,
): Promise<ExpireOutcome> {
  let outcome: ExpireOutcome;
  try {
    outcome = await expireOne(container, orderId, now, breaker);
  } catch (e) {
    // Lỗi ở pha chốt hủy (kết quả cổng đã rõ, hủy native đã xong) → thử lại sau 1 phút, không tăng số mũ; lỗi khác →
    // backoff. Lỗi khi hẹn (vd. DB đang hỏng) không được che lỗi gốc — chỉ log tên lỗi, ném lỗi gốc.
    const commit = e instanceof CancelCommitError;
    const original = commit ? e.cause : e;
    await scheduleRecheck(container, orderId, now, commit ? "retry" : "backoff").catch((err: unknown) =>
      logger(container).warn(
        `[expire-holds] Không hẹn kiểm lại được đơn ${orderId}: ${err instanceof Error ? err.name : "lỗi"}`,
      ),
    );
    throw original;
  }
  if (outcome === "unknown") await scheduleRecheck(container, orderId, now, "backoff");
  else if (outcome === "deferred") await scheduleRecheck(container, orderId, now, "retry");
  return outcome;
}

/** Lỗi ở pha chốt hủy của `expireOne` (sau `cancelNativeOrder`) — bọc để biết không cần tăng số mũ backoff. */
class CancelCommitError extends Error {
  constructor(override readonly cause: unknown) {
    super("cancel commit failed");
    this.name = "CancelCommitError";
  }
}

/**
 * Hẹn kiểm lại (T-164): `backoff` → số mũ + 1, chờ `holdRecheckDelayMs`; `retry` (breaker hoãn / lỗi pha chốt hủy) →
 * giữ số mũ, chờ 1 phút. Mốc = `now + delay − slack` (lib/checkout/hold-recheck.ts).
 */
async function scheduleRecheck(
  container: MedusaContainer,
  orderId: string,
  now: Date,
  mode: "backoff" | "retry",
): Promise<void> {
  const s = service(container);
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  if (!fin || fin.state !== "awaiting_payment") return;
  const from = fin.hold_check_attempts;
  const attempts = mode === "backoff" ? from + 1 : from;
  const delay = mode === "backoff" ? holdRecheckDelayMs(attempts) : HOLD_RECHECK_POLICY.deferMs;
  await s.scheduleHoldRecheck(orderId, {
    next_check_at: holdRecheckAt(now, delay),
    fromAttempts: from,
    attempts,
  });
}

/** Xoay trái `n` vị trí (n ≥ 0; mảng rỗng → rỗng). */
export function rotate<T>(items: readonly T[], n: number): T[] {
  if (items.length === 0) return [];
  const k = ((n % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/**
 * Thứ tự xét đơn quá hạn (review T-161): breaker đóng → giữ nguyên (mọi đơn đều được hỏi, kể cả đơn đang lỗi). Breaker
 * chưa đóng → đơn đầu hàng nhận lượt thử half-open, nên (1) xoay theo `trip_count` để lượt thử đổi đơn sau mỗi lần thử
 * lỗi và (2) đơn gây lỗi tạm gần nhất (`last_failed_event_id`) luôn xuống CUỐI — lượt thử KHÔNG BAO GIỜ rơi lại vào đơn
 * vừa lỗi khi còn đơn khác (kể cả khi đơn mới vào làm phép xoay trùng vị trí). Chỉ còn mỗi đơn đó → nó vẫn được thử.
 */
export function probeOrder(
  due: readonly string[],
  snap: Pick<JobBreakerSnapshot, "state" | "trip_count" | "last_failed_event_id"> | null,
): string[] {
  if (!snap || snap.state === "closed") return [...due];
  const rotated = rotate(due, snap.trip_count);
  const last = snap.last_failed_event_id;
  if (last === null || rotated.length < 2 || !rotated.includes(last)) return rotated;
  return [...rotated.filter((id) => id !== last), last];
}

/** Cổng querydr của MỘT đơn qua breaker của lượt chạy (lỗi tạm tính theo đơn — một đơn lỗi lặp chỉ tính một). */
function querydrGate(breaker: BreakerRun, orderId: string, now: Date): QueryGate {
  const key = VNPAY_QUERYDR_BREAKER_KEY;
  return {
    admit: async () => {
      const a = await breaker.admit(key, now);
      return a.kind === "call" ? null : `breaker_${a.reason}`;
    },
    settle: async (raw) => {
      if (isTransientQueryFailure(raw.reason)) await breaker.onFailure(key, orderId, now);
      // Cổng đã trả lời (kể cả `unknown` vì chữ ký/số tiền sai — D-111): half_open → closed; closed → xoá đếm lỗi.
      else await breaker.onSuccess(key);
    },
  };
}

type ExpireOutcome = "cancelled" | "confirmed" | "unknown" | "deferred" | "skipped";

async function expireOne(
  container: MedusaContainer,
  orderId: string,
  now: Date,
  breaker: BreakerRun,
): Promise<ExpireOutcome> {
  const s = service(container);
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  // Kiểm lại SAU khi có khóa: IPN/lượt expiry khác có thể đã xử lý — hoặc đã hỏi và hẹn kiểm lại (T-164: hai lượt
  // song song không hỏi querydr hai lần cho cùng đơn).
  if (
    !fin ||
    fin.state !== "awaiting_payment" ||
    !fin.hold_expires_at ||
    new Date(fin.hold_expires_at) > now ||
    (fin.next_check_at !== null && new Date(fin.next_check_at) > now)
  ) {
    return "skipped";
  }
  const q = await queryAndProcess(container, orderId, {
    orderLockHeld: true,
    gate: querydrGate(breaker, orderId, now),
  });
  if (q.outcome === "paid") {
    const [after] = await s.listOrderFinances({ order_id: orderId });
    return after?.state === "confirmed" ? "confirmed" : "skipped";
  }
  // Breaker mở/đang thử/bóp → chưa hỏi được: trạng thái tiền CHƯA RÕ, đi đúng đường `unknown` (không bao giờ suy ra "chưa trả").
  if (q.outcome === "unknown" || q.outcome === "deferred") {
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
    return q.outcome;
  }
  // not_paid | failed | skipped (không còn attempt mở) → hủy. Native trước (idempotent), rồi chốt trạng thái module:
  // chết giữa chừng thì lần chạy sau thấy đơn vẫn awaiting_payment và làm lại an toàn.
  await cancelNativeOrder(container, orderId);
  try {
    return (await s.cancelExpiredOrder(orderId, "HOLD_EXPIRED")) ? "cancelled" : "skipped";
  } catch (e) {
    throw new CancelCommitError(e);
  }
}

/* ---------------------------------------------------------------- reconcile-attempts */

export interface ReconcileSummary {
  compensated: string[];
  skipped: string[];
  /** Dừng ở ranh giới giữa hai attempt vì tiến trình đang tắt (T-172/D-081); phần còn lại chờ lượt sau. */
  stopped: "draining" | null;
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
  const summary: ReconcileSummary = { compensated: [], skipped: [], stopped: null };
  for (const a of await s.listStaleAttempts(now, opts.limit ?? 50)) {
    // Ranh giới giữa hai attempt (T-172/D-081): chưa claim attempt nào khi dừng → attempt còn `preparing` quá lease.
    if (isDraining()) {
      summary.stopped = "draining";
      logger(container).info(
        "[reconcile-attempts] Đang tắt — dừng ở ranh giới attempt, phần còn lại chờ lượt sau",
      );
      break;
    }
    const outcome = await withLock(
      container,
      lockKeys.cart(a.cart_id),
      STALE_ATTEMPT_LOCK_WAIT_MS,
      "cart",
      async () => {
        if (!(await s.claimStaleAttempt(a.id, now))) return "skipped" as const;
        const { orderIds, reservationIds } = await leftoversOfAttempt(container, a.id);
        if (reservationIds.length > 0) {
          await deleteReservationsWorkflow(container).run({ input: { ids: reservationIds } });
        }
        for (const id of orderIds) await cancelNativeOrder(container, id);
        await s.compensateAttemptRecords(a.id, orderIds);
        return "compensated" as const;
      },
    );
    summary[outcome === "busy" ? "skipped" : outcome].push(a.id);
  }
  return summary;
}

/* ---------------------------------------------------------------- cod-confirm-timeout */

/** Đơn COD quá hạn xác nhận → ngoại lệ cho nhân viên đơn (KHÔNG tự hủy — §6.3). Mỗi đơn một ngoại lệ. */
export async function codConfirmTimeout(
  container: MedusaContainer,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ opened: string[]; stopped: "draining" | null }> {
  const now = opts.now ?? new Date();
  const s = service(container);
  const opened: string[] = [];
  let stopped: "draining" | null = null;
  for (const o of await s.listOverdueCodOrders(now, opts.limit ?? 200)) {
    // Ranh giới giữa hai đơn (T-172/D-081): đang tắt → không mở ngoại lệ tiếp; đơn chưa xét vẫn quá hạn cho lượt sau.
    if (isDraining()) {
      stopped = "draining";
      break;
    }
    const isNew = await s.openOpsException({
      kind: "cod_confirm_overdue",
      dedupe_key: `cod_confirm_overdue:${o.order_id}`,
      order_id: o.order_id,
      priority: "high",
      due_at: new Date(now.getTime() + COD_OVERDUE_EXCEPTION_DUE_MS),
      detail: { display_ref: o.display_ref, owner_role: "order_staff" },
    });
    if (isNew) opened.push(o.order_id);
  }
  return { opened, stopped };
}

/* ---------------------------------------------------------------- outbox-dispatch */

/**
 * Ngữ cảnh một lần xử lý: `now` = thời điểm xử lý sự kiện theo đồng hồ của dispatcher (`opts.now`, không thì `clock()`
 * lúc gọi bộ xử lý) — bộ xử lý cần giờ (vd. hạn token liên kết tính từ LÚC GỬI, T-149) dùng giá trị này để test tiêm được.
 */
export interface OutboxHandlerContext {
  now: Date;
  /**
   * Trạng thái dùng chung giữa các lần gọi bộ xử lý trong CÙNG một lượt `dispatchOutbox` (mới mỗi lượt) — vd. trần gọi
   * mạng mỗi lượt của `catalog.revalidate` (T-142, D-081). Khoá theo loại sự kiện.
   */
  runState: Map<string, unknown>;
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
  // Webhook vô hiệu hoá cache catalog của storefront (T-142) — đường dự phòng khi lượt gửi gộp cuối cửa sổ lỗi.
  [CATALOG_REVALIDATE_EVENT]: catalogRevalidateHandler,
  "payment.native_sync": async (container, event) => {
    const orderId = String(event.payload.order_id ?? event.aggregate_id);
    const r = await withLock(
      container,
      lockKeys.order(orderId),
      CHECKOUT_CONFIG.orderLockWaitMs,
      "order",
      () => syncNativePayment(container, orderId),
    );
    if (r === "busy") {
      // Bận vì đang tắt (T-174): không phải lỗi của sự kiện → dispatcher hoãn, không tính lần thử.
      if (isDraining()) throw new OutboxDrainingDeferral();
      throw new Error("đơn đang bận");
    }
  },
};

/** Hoãn sự kiện outbox vì tiến trình đang tắt (T-174): không tăng `attempts`, không báo breaker, không dead. */
export class OutboxDrainingDeferral extends Error {
  override readonly name = "OutboxDrainingDeferral";
  constructor() {
    super("đang tắt — hoãn sự kiện cho lượt sau");
  }
}
/** Hẹn lại sau khi hoãn vì tắt: ngắn để instance khác nhận (claim lease đã đẩy `next_attempt_at` xa). */
export const OUTBOX_DRAINING_DEFER_MS = secondsToMs(5);

const logHandler: OutboxHandler = async (container, event) => {
  logger(container).info(`[outbox] ${event.type} ${event.event_key} (không có bộ xử lý — chỉ ghi log)`);
};

export interface DispatchSummary {
  sent: string[];
  retried: string[];
  dead: string[];
  /** Hoãn không thử vì circuit breaker mở/đang thử/bóp (T-097) — vẫn trong outbox, `attempts` không đổi. */
  deferred: string[];
  /**
   * Lượt chạy dừng sớm: `max_calls` = chạm trần lượt gọi (`OUTBOX_RUN_LIMITS.maxCalls`); `draining` = tiến trình đang tắt
   * (T-172/D-081, kiểm TRƯỚC khi nhận nên không có dòng nhận mà chưa xử lý); null = không.
   */
  stopped: "max_calls" | "draining" | null;
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
  // Map (không phải object thường): loại sự kiện là dữ liệu trong DB — `constructor`/`__proto__`/`toString` không được trúng
  // khoá của Object.prototype. `Object.entries` chỉ lấy khoá riêng.
  const handlers = new Map<string, OutboxHandler>([
    ...Object.entries(DEFAULT_OUTBOX_HANDLERS),
    ...Object.entries(opts.handlers ?? {}),
  ]);
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
  // Trạng thái theo lượt cho bộ xử lý (T-142: trần gọi mạng mỗi lượt của catalog.revalidate).
  const runState = new Map<string, unknown>();

  const markDead = async (event: OutboxClaim, message: string, reason: DeadReason) => {
    await s.markOutboxFailed(event.id, message, null);
    // Thông báo khách hỏng → ngoại lệ riêng cho người theo dõi gửi tin (AT18); đơn không bị ảnh hưởng.
    const kind = isNotificationEvent(event.type) ? "notification_failed" : "outbox_dead";
    const exception = {
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
    } as const;
    if (event.type === CATALOG_REVALIDATE_EVENT) {
      // T-142: webhook revalidate chết hàng loạt khi storefront lệch khoá/hỏng → MỘT ngoại lệ đang mở cho loại này, ưu
      // tiên thường (dữ liệu vẫn tươi lại theo TTL), không mỗi dòng một ngoại lệ high (D-107, phạm vi `type`).
      await s.openOpsExceptionIfNoneActive({ ...exception, priority: "normal", active_scope: ["type"] });
    } else {
      await s.openOpsException(exception);
    }
    summary.dead.push(event.event_key);
  };

  const iterations = Math.min(opts.limit ?? limits.maxIterations, limits.maxIterations);
  for (let i = 0; i < iterations; i++) {
    // Đang tắt (T-172/D-081): kiểm TRƯỚC khi nhận — không claim thêm, dòng chưa nhận vẫn `pending` cho lượt sau.
    if (isDraining()) {
      summary.stopped = "draining";
      log.info("[outbox] Đang tắt — dừng ở ranh giới sự kiện, phần còn lại chờ lượt sau");
      break;
    }
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
    const handler = handlers.get(event.type);
    const key = breakerKeyOf(event.type);
    let probe = false;
    if (handler) {
      const admission = await breaker.admit(key, opts.now ?? clock(), subBudgetOf(policy, event.type));
      if (admission.kind === "defer") {
        await s.deferOutbox(event.id, admission.until);
        summary.deferred.push(event.event_key);
        continue;
      }
      probe = admission.probe;
    }
    let ok = false;
    try {
      await (handler ?? logHandler)(container, event, { now: opts.now ?? clock(), runState });
      await s.markOutboxSent(event.id);
      summary.sent.push(event.event_key);
      ok = true;
    } catch (e) {
      if (e instanceof OutboxDrainingDeferral) {
        await s.deferOutbox(event.id, new Date((opts.now ?? clock()).getTime() + OUTBOX_DRAINING_DEFER_MS));
        summary.deferred.push(event.event_key);
        continue;
      }
      const failed = event.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      const info = retryInfoOf(e);
      // Hẹn tính từ LÚC LỖI (không phải đầu lượt): lượt dài vẫn chờ đủ Retry-After/backoff. `now` tiêm → mốc cố định.
      const failedAt = opts.now ?? clock();
      if (info.permanent) {
        // 4xx nghiệp vụ / validate: thử lại không đổi được kết quả → DLQ ngay (BE-JOB-003).
        await markDead(event, message, "permanent_error");
        // Lượt thử half-open nhận lỗi vĩnh viễn = dịch vụ đã TRẢ LỜI → đóng breaker (D-111). Ngoài lượt thử: trung lập
        // (lỗi của riêng sự kiện, không nói gì về sức khoẻ adapter).
        if (handler && probe) await breaker.onSuccess(key);
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
