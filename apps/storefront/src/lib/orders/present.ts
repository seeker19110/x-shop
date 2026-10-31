import { formatVnd } from "../format-vnd";
import type { OrderDetails } from "./types";
import { isNonEmpty } from "../presence";
import { t } from "../i18n";

/**
 * Nội dung 3 khối "Đặt đơn" / "Thanh toán" / "Giao hàng" (CHK06) — thuần, dễ test. Chỉ nói "đã thanh toán" khi server
 * báo `payment_state = paid` (AT08, AT24); online đang chờ → "Đang xác nhận thanh toán", không mời trả tiền lần nữa.
 */
export type Tone = "info" | "success" | "warning" | "neutral";

export interface StatusBlock {
  title: string;
  status: string;
  detail: string | null;
  tone: Tone;
}

export interface OrderPresentation {
  placement: StatusBlock;
  payment: StatusBlock;
  shipment: StatusBlock;
  /** Đơn online còn chờ: hiện nút "Kiểm tra lại". */
  showRecheck: boolean;
  /** Đã hết hạn và đã hủy: hướng dẫn đặt lại. */
  showReorder: boolean;
}

const TIME = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Giờ Việt Nam để hiển thị (dữ liệu luôn lưu UTC). */
export function formatOrderTime(iso: string | null): string {
  if (!isNonEmpty(iso)) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : TIME.format(new Date(ms));
}

function placement(o: OrderDetails): StatusBlock {
  const title = t("orders.present.placement.title");
  switch (o.state) {
    case "placed":
      return {
        title,
        status: t("orders.present.placement.placed"),
        detail: isNonEmpty(o.codConfirmBy)
          ? t("orders.present.placement.placedCod", {
              phone: o.contact.phone,
              time: formatOrderTime(o.codConfirmBy),
            })
          : null,
        tone: "info",
      };
    case "awaiting_payment":
      return { title, status: t("orders.present.placement.awaitingPayment"), detail: null, tone: "info" };
    case "confirmed":
      return { title, status: t("orders.present.placement.confirmed"), detail: null, tone: "success" };
    case "completed":
      return { title, status: t("orders.present.placement.completed"), detail: null, tone: "success" };
    case "cancelled":
      return {
        title,
        status: t("orders.present.placement.cancelled"),
        detail:
          o.cancelReason === "HOLD_EXPIRED"
            ? t("orders.present.placement.holdExpired")
            : o.cancelReason === "CUSTOMER_CANCELLED"
              ? t("orders.present.placement.customerCancelled")
              : null,
        tone: "neutral",
      };
  }
}

function payment(o: OrderDetails, now: Date): StatusBlock {
  const title = t("orders.present.payment.title");
  const holdOver = o.holdExpiresAt !== null && Date.parse(o.holdExpiresAt) <= now.getTime();
  switch (o.paymentState) {
    case "cod":
      return {
        title,
        status: t("orders.present.payment.cod"),
        detail: t("orders.present.payment.codDetail", { amount: formatVnd(o.totals.total) }),
        tone: "info",
      };
    case "paid":
      return {
        title,
        status: t("orders.present.payment.paid", { amount: formatVnd(o.totals.paid) }),
        detail: null,
        tone: "success",
      };
    case "refund_pending":
      return {
        title,
        status: t("orders.present.payment.refundPending"),
        detail: t("orders.present.payment.refundDetail", { amount: formatVnd(o.totals.paid) }),
        tone: "warning",
      };
    case "expired":
      return {
        title,
        status: t("orders.present.payment.expired"),
        detail: t("orders.present.payment.expiredDetail"),
        tone: "neutral",
      };
    case "void":
      return { title, status: t("orders.present.payment.void"), detail: null, tone: "neutral" };
    case "pending":
    case "unknown":
      return {
        title,
        status: t("orders.present.payment.pending"),
        detail: holdOver
          ? t("orders.present.payment.holdOver")
          : isNonEmpty(o.holdExpiresAt)
            ? t("orders.present.payment.holdUntil", { time: formatOrderTime(o.holdExpiresAt) })
            : t("orders.present.payment.noHold"),
        tone: "warning",
      };
  }
}

const SHIPMENT_LABELS: Record<OrderDetails["shipmentState"], string> = {
  unfulfilled: t("orders.present.shipment.unfulfilled"),
  picking: t("orders.present.shipment.picking"),
  packed: t("orders.present.shipment.packed"),
  shipped: t("orders.present.shipment.shipped"),
  delivered: t("orders.present.shipment.delivered"),
};

function shipment(o: OrderDetails): StatusBlock {
  const title = t("orders.present.shipment.title");
  if (o.state === "cancelled" && o.shipmentState === "unfulfilled") {
    return { title, status: t("orders.present.shipment.cancelledNone"), detail: null, tone: "neutral" };
  }
  return {
    title,
    status: SHIPMENT_LABELS[o.shipmentState],
    detail: t("orders.detail.address", {
      line: o.address.line,
      ward: o.address.wardName,
      province: o.address.provinceName,
    }),
    tone: o.shipmentState === "delivered" ? "success" : "info",
  };
}

export function presentOrder(o: OrderDetails, now: Date = new Date()): OrderPresentation {
  return {
    placement: placement(o),
    payment: payment(o, now),
    shipment: shipment(o),
    showRecheck: o.canRecheck && (o.paymentState === "pending" || o.paymentState === "unknown"),
    showReorder: o.state === "cancelled" && o.paymentState === "expired",
  };
}
