import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  ledgerTotals,
  type AddressSnapshot,
  type QuoteBreakdown,
  type ShipmentState,
  isNonEmpty,
} from "@x-shop/domain";
import { maskFreeText } from "../audit/sanitize";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { SHIPPING_MODULE } from "../../modules/shipping";
import type ShippingModuleService from "../../modules/shipping/service";
import type { ShipmentRow } from "../../modules/shipping/service";

/**
 * Hình đơn trả cho khách (API-CONTRACT "Đơn hàng sau mua"): ba trạng thái tách riêng — đặt đơn (`state`), thanh toán
 * (`payment_state`), giao hàng (`shipment_state`) — + timeline. Tiền: số nguyên VND; thời gian ISO 8601 UTC.
 * Liên hệ được che một phần; không trả email, id nội bộ của payment/ledger hay dữ liệu provider.
 */
export type PaymentStateView =
  | "cod" // thu khi nhận hàng
  | "pending" // đang chờ / đang xác nhận với cổng
  | "unknown" // cổng chưa trả lời rõ — đang đối soát
  | "paid"
  | "refund_pending" // đã thu nhưng đơn hủy — chờ hoàn tiền
  | "expired" // hết hạn thanh toán, đơn đã hủy
  | "void"; // đơn hủy, không có khoản thu

export type ShipmentStateView = "unfulfilled" | "picking" | "packed" | "shipped" | "delivered";

export interface OrderView {
  display_ref: string;
  state: string;
  payment_method: string;
  payment_state: PaymentStateView;
  shipment_state: ShipmentStateView;
  created_at: string;
  hold_expires_at: string | null;
  cod_confirm_by: string | null;
  cancel_reason: string | null;
  timeline: Array<{ at: string; kind: string; label: string }>;
  lines: Array<{
    title: string;
    variant_title: string | null;
    quantity: number;
    unit_price: number;
    total: number;
    thumbnail: string | null;
  }>;
  totals: {
    subtotal: number;
    discount_total: number;
    shipping_total: number;
    total: number;
    paid: number;
  };
  address: { province_name: string; ward_name: string; line: string };
  contact: { name: string; phone: string };
  actions: { can_cancel: boolean; can_recheck: boolean };
}

export interface OrderFinanceRow {
  order_id: string;
  display_ref: string;
  checkout_attempt_id: string;
  state: string;
  total: number;
  payment_method: string;
  hold_expires_at: Date | string | null;
  cod_confirm_by: Date | string | null;
  quote: unknown;
  address: unknown;
  contact: unknown;
  created_at: Date | string;
}

interface NativeItem {
  title?: string | null;
  product_title?: string | null;
  variant_title?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  thumbnail?: string | null;
  metadata?: Record<string, unknown> | null;
}
interface NativeFulfillment {
  canceled_at?: string | Date | null;
  packed_at?: string | Date | null;
  shipped_at?: string | Date | null;
  delivered_at?: string | Date | null;
  created_at?: string | Date | null;
}

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
const iso = (d: Date | string | null | undefined) => (isNonEmpty(d) ? new Date(d).toISOString() : null);

/** Trạng thái đặt đơn cho phép khách tự hủy (POST02) — thêm điều kiện chưa có vận đơn. */
export const CUSTOMER_CANCELLABLE_STATES = ["placed", "awaiting_payment", "confirmed"] as const;

/** 0912345678 → 0912***678. */
export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 4)}***${phone.slice(-3)}` : "***";
}

export function shipmentStateOf(fulfillments: readonly NativeFulfillment[]): ShipmentStateView {
  const active = fulfillments.filter((f) => !isNonEmpty(f.canceled_at));
  if (active.length === 0) return "unfulfilled";
  if (active.some((f) => isNonEmpty(f.delivered_at))) return "delivered";
  if (active.some((f) => isNonEmpty(f.shipped_at))) return "shipped";
  if (active.some((f) => isNonEmpty(f.packed_at))) return "packed";
  return "picking";
}

/** Trạng thái vận đơn GHN → trạng thái giao khách thấy (giao lỗi/đang hoàn vẫn là "đã giao cho hãng"). */
const ROW_VIEW: Record<ShipmentState, ShipmentStateView> = {
  unfulfilled: "unfulfilled",
  picking: "picking",
  packed: "packed",
  shipped: "shipped",
  failed: "shipped",
  returning: "shipped",
  returned: "shipped",
  delivered: "delivered",
};

/**
 * Trạng thái giao của đơn: fulfillment native là nguồn chính (T-043 tạo cùng vận đơn GHN); vận đơn đã có ở hãng mà
 * fulfillment native chưa ghi nhận được (lỗi dữ liệu, chờ đồng bộ) → lấy theo vận đơn, không báo nhầm "chưa giao".
 */
export function orderShipmentState(
  fulfillments: readonly NativeFulfillment[],
  shipment: Pick<ShipmentRow, "state" | "provider_order_code"> | null,
): ShipmentStateView {
  const native = shipmentStateOf(fulfillments);
  if (native !== "unfulfilled" || !shipment || !isNonEmpty(shipment.provider_order_code)) return native;
  return ROW_VIEW[shipment.state] ?? "packed";
}

/**
 * Khách tự hủy được (POST02, S-309): trạng thái cho phép + chưa có fulfillment + CHƯA có vận đơn — kể cả vận đơn đang
 * chờ hãng trả lời (giữ chỗ khi timeout) — cùng điều kiện với `cancelByCustomer`.
 */
export function customerCanCancel(
  state: string,
  shipmentState: ShipmentStateView,
  shipment: object | null | undefined,
): boolean {
  return (
    (CUSTOMER_CANCELLABLE_STATES as readonly string[]).includes(state) &&
    shipmentState === "unfulfilled" &&
    !shipment
  );
}

export async function nativeOrderParts(
  container: MedusaContainer,
  orderId: string,
): Promise<{ items: NativeItem[]; fulfillments: NativeFulfillment[] }> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: [
      "id",
      "items.title",
      "items.product_title",
      "items.variant_title",
      "items.quantity",
      "items.unit_price",
      "items.thumbnail",
      "items.metadata",
      "fulfillments.canceled_at",
      "fulfillments.packed_at",
      "fulfillments.shipped_at",
      "fulfillments.delivered_at",
      "fulfillments.created_at",
    ],
    filters: { id: orderId },
  });
  const o = (data as Array<{ items?: NativeItem[] | null; fulfillments?: NativeFulfillment[] | null }>)[0];
  return {
    items: (o?.items ?? []).filter(Boolean),
    fulfillments: (o?.fulfillments ?? []).filter(Boolean),
  };
}

const CANCEL_LABELS: Record<string, string> = {
  CUSTOMER_CANCELLED: "Bạn đã hủy đơn",
  SHOP_CANCELLED: "Cửa hàng đã hủy đơn",
  HOLD_EXPIRED: "Đơn đã hủy do quá hạn thanh toán",
};

export async function presentOrder(container: MedusaContainer, fin: OrderFinanceRow): Promise<OrderView> {
  const s = service(container);
  const orderId = fin.order_id;
  const [entries, ledgerRows, outbox, payments, refundRequests, native, shipment] = await Promise.all([
    s.ledgerEntriesOf(orderId),
    s.listPaymentLedgers({ order_id: orderId }, { order: { created_at: "ASC" } }),
    s.listOutboxEvents({ aggregate_id: orderId }, { order: { created_at: "ASC" } }),
    s.listPaymentAttempts({ order_id: orderId }, { order: { created_at: "DESC" } }),
    s.listOpsExceptions({ order_id: orderId, kind: ["refund_request", "late_payment", "overpayment"] }),
    nativeOrderParts(container, orderId),
    container.resolve<ShippingModuleService>(SHIPPING_MODULE).shipmentOfOrder(orderId),
  ]);
  const paid = Math.max(0, ledgerTotals(entries).net);
  const cancelEvent = outbox.find((e) => e.type === "order.cancelled");
  const cancelReason =
    fin.state === "cancelled"
      ? String((cancelEvent?.payload as { reason?: unknown } | null)?.reason ?? "CANCELLED")
      : null;

  let paymentState: PaymentStateView;
  if (fin.state === "cancelled") {
    paymentState = paid > 0 ? "refund_pending" : cancelReason === "HOLD_EXPIRED" ? "expired" : "void";
  } else if (paid > 0 && paid >= fin.total) {
    paymentState = "paid";
  } else if (fin.payment_method === "cod") {
    paymentState = "cod";
  } else {
    const open = payments.find((p) => ["created", "pending", "unknown"].includes(p.state));
    paymentState = open?.state === "unknown" ? "unknown" : "pending";
  }

  const shipmentState = orderShipmentState(native.fulfillments, shipment);

  const timeline: OrderView["timeline"] = [
    {
      at: iso(fin.created_at) as string,
      kind: "placed",
      label: fin.payment_method === "cod" ? "Đã đặt đơn — thanh toán khi nhận hàng" : "Đã đặt đơn",
    },
  ];
  for (const l of ledgerRows) {
    timeline.push({
      at: iso(l.created_at) as string,
      kind: l.kind === "capture" ? "payment_captured" : "refund",
      label: l.kind === "capture" ? "Đã nhận thanh toán" : "Đã hoàn tiền",
    });
  }
  for (const e of outbox) {
    if (e.type === "order.confirmed") {
      timeline.push({ at: iso(e.created_at) as string, kind: "confirmed", label: "Đơn đã được xác nhận" });
    } else if (e.type === "order.cancelled") {
      timeline.push({
        at: iso(e.created_at) as string,
        kind: "cancelled",
        label: CANCEL_LABELS[cancelReason ?? ""] ?? "Đơn đã hủy",
      });
    }
  }
  if (refundRequests.length > 0) {
    const first = refundRequests.reduce((a, b) => (new Date(a.created_at) <= new Date(b.created_at) ? a : b));
    timeline.push({
      at: iso(first.created_at) as string,
      kind: "refund_requested",
      label: "Đã ghi nhận yêu cầu hoàn tiền",
    });
  }
  for (const f of native.fulfillments.filter((x) => !isNonEmpty(x.canceled_at))) {
    if (isNonEmpty(f.shipped_at)) {
      timeline.push({
        at: iso(f.shipped_at) as string,
        kind: "shipped",
        label: "Đã giao cho đơn vị vận chuyển",
      });
    }
    if (isNonEmpty(f.delivered_at)) {
      timeline.push({ at: iso(f.delivered_at) as string, kind: "delivered", label: "Đã giao hàng" });
    }
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  const quote = (fin.quote ?? {}) as Partial<QuoteBreakdown>;
  const byCartLine = new Map<string, NativeItem>();
  for (const it of native.items) {
    const key = it.metadata?.cart_line_item_id;
    if (typeof key === "string") byCartLine.set(key, it);
  }
  const lines: OrderView["lines"] = (quote.lines ?? []).map((q) => {
    const it = byCartLine.get(q.lineId);
    return {
      title: it?.product_title ?? it?.title ?? "Sản phẩm",
      variant_title: it?.variant_title ?? null,
      quantity: q.quantity,
      unit_price: q.unitPrice,
      total: q.lineTotal,
      thumbnail: it?.thumbnail ?? null,
    };
  });

  const address = (fin.address ?? {}) as Partial<AddressSnapshot>;
  const contact = (fin.contact ?? {}) as { name?: string; phone?: string };
  const holdExpiresAt = iso(fin.hold_expires_at);
  const cancellable = customerCanCancel(fin.state, shipmentState, shipment);

  return {
    display_ref: fin.display_ref,
    state: fin.state,
    payment_method: fin.payment_method,
    payment_state: paymentState,
    shipment_state: shipmentState,
    created_at: iso(fin.created_at) as string,
    hold_expires_at: holdExpiresAt,
    cod_confirm_by: iso(fin.cod_confirm_by),
    cancel_reason: maskFreeText(cancelReason),
    timeline,
    lines,
    totals: {
      subtotal: quote.subtotal ?? 0,
      discount_total: quote.orderDiscountTotal ?? 0,
      shipping_total: quote.shippingTotal ?? 0,
      total: fin.total,
      paid,
    },
    address: {
      province_name: address.provinceName ?? "",
      ward_name: address.wardName ?? "",
      line: address.line ?? "",
    },
    contact: { name: contact.name ?? "", phone: maskPhone(contact.phone ?? "") },
    actions: {
      can_cancel: cancellable,
      // "Kiểm tra lại" truy vấn CÙNG giao dịch (S-104) — không mời trả tiền lần nữa.
      can_recheck: fin.payment_method === "vnpay" && fin.state === "awaiting_payment",
    },
  };
}
