import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { deleteReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { decideIdempotency, ledgerTotals, payloadHash, type OrderState } from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type { OrderCancelRow } from "../../modules/returns/service";
import { SHIPPING_MODULE } from "../../modules/shipping";
import type ShippingModuleService from "../../modules/shipping/service";
import { ReturnsError } from "../../workflows/returns/errors";
import { returnsOf } from "../../workflows/returns/order-context";
import { audit, openCancellationRefund, type AuditCtx } from "../../workflows/returns/refunds";
import type CheckoutModuleService from "../../modules/checkout/service";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { CheckoutError, readCheckoutError } from "../checkout/errors";
import { cancelNativeOrder } from "../checkout/jobs";
import { acquireOrdered, lockKeys, releaseOwned } from "../checkout/locks";
import { queryAndProcess } from "../checkout/recheck";
import { CUSTOMER_CANCELLABLE_STATES, nativeOrderParts, shipmentStateOf } from "./view";

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

export interface CancelResult {
  outcome: "cancelled" | "already_cancelled";
  refund_requested: boolean;
}

/** Ai hủy: khách (trang đơn) hay nhân viên `order.cancel` (Admin — T-044, lý do bắt buộc). */
type Canceller = { by: "customer" } | { by: "staff"; actor_id: string; reason: string; auditCtx: AuditCtx };

interface CoreResult extends CancelResult {
  from: OrderState | null;
  refund_amount: number;
  refund_id: string | null;
}

/** Nhả reservation theo line item của đơn mà KHÔNG hủy đơn native (đơn đã thu tiền — xem `cancelLocked`). */
export async function releaseReservations(container: MedusaContainer, orderId: string): Promise<void> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: ["id", "items.id"],
    filters: { id: orderId },
  });
  const lineIds = (data as Array<{ items?: Array<{ id: string } | null> }>).flatMap((o) =>
    (o.items ?? []).flatMap((i) => (i ? [i.id] : [])),
  );
  if (lineIds.length === 0) return;
  const reservations = await container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ line_item_id: lineIds });
  if (reservations.length > 0) {
    await deleteReservationsWorkflow(container).run({ input: { ids: reservations.map((r) => r.id) } });
  }
}

/** Giữ khóa `order:<id>` (cùng khóa với IPN/expiry/recheck/hoàn tiền) trong lúc chạy `fn`. */
async function withCancelLock<T>(
  container: MedusaContainer,
  orderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locking = container.resolve(Modules.LOCKING);
  const owner = `cancel:${randomUUID()}`;
  try {
    await acquireOrdered(locking, [lockKeys.order(orderId)], {
      ownerId: owner,
      waitMs: CHECKOUT_CONFIG.orderLockWaitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope: "order",
    });
  } catch (e) {
    throw readCheckoutError(e) ?? e;
  }
  try {
    return await fn();
  } finally {
    await releaseOwned(locking, owner, null);
  }
}

/**
 * Lõi hủy đơn (POST02, S-309) — gọi khi ĐÃ giữ khóa `order:<id>`; kiểm lại trạng thái sau khi có khóa → gọi lặp/đồng
 * thời chỉ hủy một lần (idempotent: đơn đã hủy → `already_cancelled`).
 *
 * - Chỉ `placed | awaiting_payment | confirmed` và CHƯA có vận đơn (fulfillment chưa hủy) — đơn đã giao không "hủy" để
 *   xóa lịch sử (POST02).
 * - `awaiting_payment`: hỏi cổng trước (querydr, cùng đường IPN). Cổng chưa trả lời rõ → 409 PAYMENT_PENDING (không hủy
 *   khi tiền có thể đã trừ).
 * - Chưa thu tiền: hủy đơn native (nhả reservation) rồi chốt trạng thái module.
 * - Đã thu tiền: KHÔNG gọi hủy native — `cancelOrderWorkflow` sẽ ghi refund native qua provider hệ thống trong khi tiền
 *   thật chưa hoàn; chỉ nhả reservation, chốt `cancelled`, mở ngoại lệ `refund_request` + yêu cầu hoàn tiền (T-027);
 *   đơn native được hủy khi tiền đã hoàn thật (workflows/returns/refunds.ts).
 */
async function cancelLocked(
  container: MedusaContainer,
  orderId: string,
  who: Canceller,
  now: Date,
): Promise<CoreResult> {
  const s = service(container);
  const read = async () => (await s.listOrderFinances({ order_id: orderId }))[0];
  let fin = await read();
  if (!fin) throw new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");
  if (fin.state === "cancelled") {
    const refunds = await s.listOpsExceptions({ order_id: orderId, kind: "refund_request" });
    const refund = await returnsOf(container).findRefundByKey(`cancel:${orderId}`);
    return {
      outcome: "already_cancelled",
      refund_requested: refunds.length > 0,
      from: null,
      refund_amount: 0,
      refund_id: refund?.id ?? null,
    };
  }
  if (!(CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(fin.state)) {
    throw new CheckoutError("NOT_CANCELLABLE");
  }
  const native = await nativeOrderParts(container, orderId);
  if (shipmentStateOf(native.fulfillments) !== "unfulfilled") throw new CheckoutError("NOT_CANCELLABLE");
  // Vận đơn GHN nằm ở module shipping (không tạo fulfillment native) — đã giữ chỗ/tạo vận đơn thì không còn "hủy" được
  // nữa: đơn đã giao cho hãng/đã giao không hủy để xoá lịch sử (POST02, S-309) — đi luồng đổi trả (T-027).
  if (await container.resolve<ShippingModuleService>(SHIPPING_MODULE).shipmentOfOrder(orderId)) {
    throw new CheckoutError("NOT_CANCELLABLE");
  }

  if (fin.state === "awaiting_payment") {
    const q = await queryAndProcess(container, orderId, { orderLockHeld: true });
    if (q.outcome === "unknown") throw new CheckoutError("PAYMENT_PENDING");
    fin = await read();
    if (!fin) throw new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");
    if (!(CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(fin.state)) {
      throw new CheckoutError("NOT_CANCELLABLE");
    }
  }

  const from = fin.state as OrderState;
  const paid = Math.max(0, ledgerTotals(await s.ledgerEntriesOf(orderId)).net);
  // Native trước (idempotent), rồi chốt module: chết giữa chừng thì lần gọi sau thấy đơn chưa hủy và làm lại an toàn.
  if (paid > 0) await releaseReservations(container, orderId);
  else await cancelNativeOrder(container, orderId);
  const done = await s.cancelOrderByCustomer({
    order_id: orderId,
    from,
    refund_amount: paid,
    display_ref: fin.display_ref,
    now,
    reason: who.by === "staff" ? "SHOP_CANCELLED" : "CUSTOMER_CANCELLED",
  });
  if (!done) throw new CheckoutError("BUSY_RETRY");
  let refundId: string | null = null;
  if (paid > 0) {
    // Mở yêu cầu hoàn toàn bộ số đã thu ngay (không chờ hàng trả — §6.5); hoàn thật + hủy native khi tiền đã hoàn
    // (T-027, D-012). Lỗi ở đây không làm hỏng việc hủy: ngoại lệ `refund_request` đã mở cùng transaction ở trên.
    // Nhân viên hủy → nhân viên là người tạo yêu cầu (không tự duyệt được — S-403).
    const opening =
      who.by === "staff"
        ? openCancellationRefund(container, orderId, who.auditCtx, {
            requested_by: who.actor_id,
            note: `Cửa hàng hủy đơn đã thanh toán: ${who.reason}`.slice(0, 500),
            audit_reason: "SHOP_CANCELLED",
          })
        : openCancellationRefund(container, orderId);
    const refund = await opening.catch((e: unknown) => {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[orders] Chưa mở được yêu cầu hoàn tiền cho đơn hủy ${orderId}: ${(e as Error).message}`);
      return null;
    });
    refundId = refund?.id ?? null;
  }
  return { outcome: "cancelled", refund_requested: paid > 0, from, refund_amount: paid, refund_id: refundId };
}

/** Khách hủy đơn (POST02, S-309) — xem `cancelLocked`. */
export async function cancelByCustomer(
  container: MedusaContainer,
  orderId: string,
  now: Date = new Date(),
): Promise<CancelResult> {
  const r = await withCancelLock(container, orderId, () =>
    cancelLocked(container, orderId, { by: "customer" }, now),
  );
  return { outcome: r.outcome, refund_requested: r.refund_requested };
}

export interface StaffCancelInput {
  order_id: string;
  actor_id: string;
  /** Lý do bắt buộc (3–500 ký tự) — ghi audit và lệnh hủy. */
  reason: string;
  idempotency_key: string;
}

export interface StaffCancelResult extends CancelResult {
  refund_id: string | null;
  replayed: boolean;
}

const pgCode = (e: unknown) =>
  typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;

function replayStaffCancel(row: OrderCancelRow, hash: string): StaffCancelResult {
  if (decideIdempotency({ payloadHash: row.payload_hash }, hash) === "conflict") {
    throw new ReturnsError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho một lệnh hủy khác");
  }
  return {
    outcome: row.outcome,
    refund_requested: row.refund_requested,
    refund_id: row.refund_id,
    replayed: true,
  };
}

/**
 * Nhân viên `order.cancel` hủy đơn (T-044, D-012) — cùng lõi với khách hủy: chưa thu → hủy native + nhả hàng; đã thu →
 * `order_finance=cancelled` + nhả reservation + ngoại lệ `refund_request` + yêu cầu hoàn (người tạo = nhân viên); đã có
 * vận đơn → 409 NOT_CANCELLABLE. Lệnh hủy ghi theo `Idempotency-Key` (bảng `x_order_cancel`, UNIQUE) TRONG khóa đơn:
 * gửi lại cùng khóa → kết quả cũ (`replayed`), khác nội dung → 409 IDEMPOTENCY_CONFLICT; hai lệnh khác khóa đồng thời →
 * một `cancelled`, một `already_cancelled`. Audit `order.cancelled` (người, lý do, số tiền phải hoàn).
 */
export async function cancelByStaff(
  container: MedusaContainer,
  input: StaffCancelInput,
  auditCtx: AuditCtx,
  now: Date = new Date(),
): Promise<StaffCancelResult> {
  const svc = returnsOf(container);
  const key = `staff:${input.idempotency_key}`;
  const hash = payloadHash({ order_id: input.order_id, reason: input.reason });
  const prior = await svc.findOrderCancelByKey(key);
  if (prior) return replayStaffCancel(prior, hash);
  try {
    return await withCancelLock(container, input.order_id, async () => {
      const again = await svc.findOrderCancelByKey(key);
      if (again) return replayStaffCancel(again, hash);
      const r = await cancelLocked(
        container,
        input.order_id,
        { by: "staff", actor_id: input.actor_id, reason: input.reason, auditCtx },
        now,
      );
      await svc.insertOrderCancel({
        order_id: input.order_id,
        idempotency_key: key,
        payload_hash: hash,
        actor_id: input.actor_id,
        reason: input.reason,
        outcome: r.outcome,
        from_state: r.from,
        refund_requested: r.refund_requested,
        refund_id: r.refund_id,
      });
      if (r.outcome === "cancelled") {
        await audit(container, auditCtx, {
          action: "order.cancelled",
          resource_type: "order",
          resource_id: input.order_id,
          reason: input.reason,
          changes: {
            by: "staff",
            from: r.from,
            to: "cancelled",
            refund_amount: r.refund_amount,
            refund_id: r.refund_id,
          },
        });
      }
      return {
        outcome: r.outcome,
        refund_requested: r.refund_requested,
        refund_id: r.refund_id,
        replayed: false,
      };
    });
  } catch (e) {
    // Khóa đơn hết hạn giữa chừng và một request cùng khóa đã ghi trước → trả kết quả của nó.
    if (pgCode(e) === "23505") {
      const winner = await svc.findOrderCancelByKey(key);
      if (winner) return replayStaffCancel(winner, hash);
    }
    throw e;
  }
}
