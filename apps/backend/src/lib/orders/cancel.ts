import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { deleteReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { ledgerTotals, type OrderState } from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
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

/** Nhả reservation theo line item của đơn mà KHÔNG hủy đơn native (đơn đã thu tiền — xem `cancelByCustomer`). */
async function releaseReservations(container: MedusaContainer, orderId: string): Promise<void> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: ["id", "items.id"],
    filters: { id: orderId },
  });
  const lineIds = (data as Array<{ items?: Array<{ id: string } | null> }>).flatMap((o) =>
    (o.items ?? []).flatMap((i) => (i ? [i.id] : [])),
  );
  if (lineIds.length === 0) return;
  const reservations = await container.resolve(Modules.INVENTORY).listReservationItems({ line_item_id: lineIds });
  if (reservations.length > 0) {
    await deleteReservationsWorkflow(container).run({ input: { ids: reservations.map((r) => r.id) } });
  }
}

/**
 * Khách hủy đơn (POST02, S-309). Chạy dưới khóa `order:<id>` (cùng khóa với IPN/expiry/recheck) và kiểm lại trạng thái
 * sau khi có khóa → gọi lặp/đồng thời chỉ hủy một lần (idempotent: đơn đã hủy → `already_cancelled`).
 *
 * - Chỉ `placed | awaiting_payment | confirmed` và CHƯA có vận đơn (fulfillment chưa hủy) — đơn đã giao không "hủy" để
 *   xóa lịch sử (POST02).
 * - `awaiting_payment`: hỏi cổng trước (querydr, cùng đường IPN). Cổng chưa trả lời rõ → 409 PAYMENT_PENDING (không hủy
 *   khi tiền có thể đã trừ).
 * - Chưa thu tiền: hủy đơn native (nhả reservation) rồi chốt trạng thái module.
 * - Đã thu tiền: KHÔNG gọi hủy native — `cancelOrderWorkflow` sẽ ghi refund native qua provider hệ thống trong khi tiền
 *   thật chưa hoàn; chỉ nhả reservation, chốt `cancelled` và mở ngoại lệ `refund_request` (hoàn thật + hủy native ở T-027).
 */
export async function cancelByCustomer(
  container: MedusaContainer,
  orderId: string,
  now: Date = new Date(),
): Promise<CancelResult> {
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
    const s = service(container);
    const read = async () => (await s.listOrderFinances({ order_id: orderId }))[0];
    let fin = await read();
    if (!fin) throw new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");
    if (fin.state === "cancelled") {
      const refunds = await s.listOpsExceptions({ order_id: orderId, kind: "refund_request" });
      return { outcome: "already_cancelled", refund_requested: refunds.length > 0 };
    }
    if (!(CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(fin.state)) {
      throw new CheckoutError("NOT_CANCELLABLE");
    }
    const native = await nativeOrderParts(container, orderId);
    if (shipmentStateOf(native.fulfillments) !== "unfulfilled") throw new CheckoutError("NOT_CANCELLABLE");

    if (fin.state === "awaiting_payment") {
      const q = await queryAndProcess(container, orderId, { orderLockHeld: true });
      if (q.outcome === "unknown") throw new CheckoutError("PAYMENT_PENDING");
      fin = await read();
      if (!fin) throw new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");
      if (!(CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(fin.state)) {
        throw new CheckoutError("NOT_CANCELLABLE");
      }
    }

    const paid = Math.max(0, ledgerTotals(await s.ledgerEntriesOf(orderId)).net);
    // Native trước (idempotent), rồi chốt module: chết giữa chừng thì lần gọi sau thấy đơn chưa hủy và làm lại an toàn.
    if (paid > 0) await releaseReservations(container, orderId);
    else await cancelNativeOrder(container, orderId);
    const done = await s.cancelOrderByCustomer({
      order_id: orderId,
      from: fin.state as OrderState,
      refund_amount: paid,
      display_ref: fin.display_ref,
      now,
    });
    if (!done) throw new CheckoutError("BUSY_RETRY");
    return { outcome: "cancelled", refund_requested: paid > 0 };
  } finally {
    await releaseOwned(locking, owner, null);
  }
}
