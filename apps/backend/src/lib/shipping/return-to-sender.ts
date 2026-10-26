import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { ledgerTotals, orderMachine, type OrderState } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { AuditEntryInput } from "../../modules/audit/service";
import type { ShipmentRow } from "../../modules/shipping/service";
import { audit, openCancellationRefund } from "../../workflows/returns/refunds";
import { CARRIER_RETURN_ACTOR, receiveCarrierReturnLocked } from "../../workflows/returns/returns";
import { cancelNativeOrder } from "../checkout/jobs";
import { releaseReservations } from "../orders/cancel";
import { cancelUnshippedFulfillment, shippedOutQuantities } from "./fulfillment";

/**
 * Hàng hoàn từ hãng (T-045) — vận đơn kết thúc mà khách không nhận hàng:
 *  - `cancelled`: hãng hủy vận đơn TRƯỚC khi lấy hàng (GHN `cancel`; vận đơn đã về `unfulfilled`);
 *  - `returned`: hãng đã hoàn hàng về shop (GHN `returned`).
 * Trạng thái đã được đối chiếu qua API có token trước khi gọi (S-305). Caller giữ khóa `order:<id>`. Mọi bước idempotent
 * (callback lặp/đồng thời, sập giữa chừng → gọi lại chỉ làm tiếp phần còn thiếu):
 *  1. Hàng ĐÃ rời tồn bán (fulfillment native đã ghi sổ xuất kho) → nhận vào KHO CÁCH LY chờ kiểm định, tồn bán không
 *     đổi (INV04, D-019); hàng chưa trừ tồn thì vẫn ở tồn bán — chỉ nhả giữ hàng còn lại của đơn.
 *  2. Đơn → `cancelled` theo máy trạng thái (chỉ từ trạng thái cho phép; không đụng đơn đã kết thúc). Tiền: COD chưa thu →
 *     không ghi thu, không hoàn; đã thu online → ngoại lệ `refund_request` + yêu cầu hoàn toàn bộ ở trạng thái chờ duyệt
 *     (D-012) — KHÔNG tự hoàn.
 *  3. Native: hủy trước lấy hàng → hủy fulfillment chưa giao; đơn chưa thu → hủy đơn native ngay (đã thu: khi tiền đã
 *     hoàn — refunds.ts). Đã lấy hàng rồi hoàn → fulfillment `shipped` giữ nguyên làm lịch sử.
 */
export type CarrierOutcome = "cancelled" | "returned";

type AuditCtx = Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">;

export interface CarrierSettlement {
  outcome: CarrierOutcome;
  order_state: string;
  /** true nếu CHÍNH lần gọi này chuyển đơn sang `cancelled`. */
  order_cancelled: boolean;
  /** Số đã thu (net) lúc hủy — > 0 thì có yêu cầu hoàn chờ duyệt. */
  paid: number;
  refund_id: string | null;
  /** Yêu cầu hàng hoàn (kho cách ly); null = không có hàng nào đã rời tồn bán. */
  return_id: string | null;
  return_state: string | null;
}

const checkoutOf = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

/** Trạng thái đơn còn hủy được khi hãng hủy/hoàn (đơn có vận đơn luôn đã `confirmed`). */
const CARRIER_CANCELLABLE: readonly OrderState[] = ["placed", "confirmed"];

export async function settleCarrierReturn(
  container: MedusaContainer,
  shipment: Pick<ShipmentRow, "id" | "order_id" | "provider" | "client_order_code">,
  outcome: CarrierOutcome,
  providerStatus: string,
  auditCtx: AuditCtx,
  now: Date = new Date(),
): Promise<CarrierSettlement> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const reason = outcome === "cancelled" ? "CARRIER_CANCELLED" : "CARRIER_RETURNED";

  // 1. Hàng về kho cách ly (chỉ phần đã thực sự trừ khỏi tồn bán).
  const { fulfillment, lines } = await shippedOutQuantities(container, shipment);
  let returnId: string | null = null;
  let returnState: string | null = null;
  if (lines.size > 0) {
    const { ret } = await receiveCarrierReturnLocked(
      container,
      {
        order_id: shipment.order_id,
        client_order_code: shipment.client_order_code,
        provider: shipment.provider,
        outcome,
        provider_status: providerStatus,
        quantities: lines,
      },
      auditCtx,
    );
    returnId = ret.id;
    returnState = ret.state;
  }

  // 2. Đơn + tiền.
  const s = checkoutOf(container);
  const [fin] = await s.listOrderFinances({ order_id: shipment.order_id });
  if (!fin) throw new Error(`Không thấy order_finance của đơn ${shipment.order_id}`);
  const paid = Math.max(0, ledgerTotals(await s.ledgerEntriesOf(shipment.order_id)).net);
  let orderCancelled = false;
  let orderState = fin.state;
  if (fin.state !== "cancelled") {
    const from = fin.state as OrderState;
    if (CARRIER_CANCELLABLE.includes(from) && orderMachine.canTransition(from, "cancelled")) {
      // "Cửa hàng hủy" là nhãn khách thấy; lý do chính xác (hãng hủy/hoàn) nằm ở audit + ghi chú hoàn tiền.
      orderCancelled = await s.cancelOrderByCustomer({
        order_id: shipment.order_id,
        from,
        refund_amount: paid,
        display_ref: fin.display_ref,
        now,
        reason: "SHOP_CANCELLED",
      });
      if (!orderCancelled) throw new Error(`Đơn ${shipment.order_id} vừa đổi trạng thái — thử lại`);
      orderState = "cancelled";
      await audit(container, auditCtx, {
        action: "order.cancelled",
        resource_type: "order",
        resource_id: shipment.order_id,
        reason,
        changes: {
          by: "carrier",
          provider: shipment.provider,
          provider_status: providerStatus.slice(0, 50),
          from,
          to: "cancelled",
          refund_amount: paid,
          return_id: returnId,
        },
      });
    } else {
      logger.warn(
        `[shipping] Hãng báo ${outcome} cho đơn ${shipment.order_id} ở trạng thái ${fin.state} — không tự hủy, cần người xem`,
      );
    }
  }
  let refundId: string | null = null;
  if (orderState === "cancelled" && paid > 0) {
    // Khóa `cancel:<order>` cố định → gọi lặp không tạo thêm; người tạo là hệ thống → luôn chờ người duyệt (S-403).
    const refund = await openCancellationRefund(container, shipment.order_id, auditCtx, {
      requested_by: CARRIER_RETURN_ACTOR,
      note:
        outcome === "cancelled"
          ? `Hãng ${shipment.provider} hủy vận đơn ${shipment.client_order_code} trước khi lấy hàng`
          : `Hãng ${shipment.provider} hoàn vận đơn ${shipment.client_order_code} về shop — khách không nhận hàng`,
      audit_reason: reason,
    });
    refundId = refund?.id ?? null;
  }

  // 3. Giữ hàng còn sót (hàng chưa trừ tồn) + native.
  if (orderState === "cancelled") {
    await releaseReservations(container, shipment.order_id);
    if (outcome === "cancelled") {
      if (fulfillment) await cancelUnshippedFulfillment(container, fulfillment);
      if (paid === 0) await cancelNativeOrder(container, shipment.order_id);
    }
  }

  return {
    outcome,
    order_state: orderState,
    order_cancelled: orderCancelled,
    paid,
    refund_id: refundId,
    return_id: returnId,
    return_state: returnState,
  };
}
