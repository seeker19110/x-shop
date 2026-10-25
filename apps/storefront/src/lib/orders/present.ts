import { formatVnd } from "../format-vnd";
import type { OrderDetails } from "./types";

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
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : TIME.format(new Date(t));
}

function placement(o: OrderDetails): StatusBlock {
  const title = "Đặt đơn";
  switch (o.state) {
    case "placed":
      return {
        title,
        status: "Đã nhận đơn — chờ xác nhận",
        detail: o.codConfirmBy
          ? `Nhân viên sẽ gọi xác nhận qua số ${o.contact.phone} trước ${formatOrderTime(o.codConfirmBy)}.`
          : null,
        tone: "info",
      };
    case "awaiting_payment":
      return { title, status: "Đã nhận đơn — chờ thanh toán", detail: null, tone: "info" };
    case "confirmed":
      return { title, status: "Đơn đã được xác nhận", detail: null, tone: "success" };
    case "completed":
      return { title, status: "Đơn đã hoàn tất", detail: null, tone: "success" };
    case "cancelled":
      return {
        title,
        status: "Đơn đã hủy",
        detail:
          o.cancelReason === "HOLD_EXPIRED"
            ? "Đơn hủy tự động vì quá thời hạn thanh toán."
            : o.cancelReason === "CUSTOMER_CANCELLED"
              ? "Bạn đã hủy đơn này."
              : null,
        tone: "neutral",
      };
  }
}

function payment(o: OrderDetails, now: Date): StatusBlock {
  const title = "Thanh toán";
  const holdOver = o.holdExpiresAt !== null && Date.parse(o.holdExpiresAt) <= now.getTime();
  switch (o.paymentState) {
    case "cod":
      return {
        title,
        status: "Thanh toán khi nhận hàng",
        detail: `Số tiền cần trả khi nhận hàng: ${formatVnd(o.totals.total)}.`,
        tone: "info",
      };
    case "paid":
      return { title, status: `Đã thanh toán ${formatVnd(o.totals.paid)}`, detail: null, tone: "success" };
    case "refund_pending":
      return {
        title,
        status: "Đang xử lý hoàn tiền",
        detail: `Chúng tôi đã nhận ${formatVnd(o.totals.paid)} và sẽ hoàn lại theo chính sách hoàn tiền.`,
        tone: "warning",
      };
    case "expired":
      return {
        title,
        status: "Hết thời hạn thanh toán",
        detail: "Không có khoản tiền nào được ghi nhận cho đơn này.",
        tone: "neutral",
      };
    case "void":
      return { title, status: "Không phát sinh thanh toán", detail: null, tone: "neutral" };
    case "pending":
    case "unknown":
      return {
        title,
        status: "Đang xác nhận thanh toán",
        detail: holdOver
          ? "Thời gian giữ hàng đã hết — hệ thống đang kiểm tra kết quả cuối cùng với cổng thanh toán. Bạn không cần thanh toán lại."
          : o.holdExpiresAt
            ? `Hàng được giữ đến ${formatOrderTime(o.holdExpiresAt)}. Nếu bạn đã thanh toán, không cần thanh toán lại — bấm "Kiểm tra lại" để cập nhật.`
            : 'Nếu bạn đã thanh toán, không cần thanh toán lại — bấm "Kiểm tra lại" để cập nhật.',
        tone: "warning",
      };
  }
}

const SHIPMENT_LABELS: Record<OrderDetails["shipmentState"], string> = {
  unfulfilled: "Chưa giao — đơn sẽ được chuẩn bị sau khi xác nhận",
  picking: "Đang chuẩn bị hàng",
  packed: "Đã đóng gói, chờ bàn giao vận chuyển",
  shipped: "Đang giao hàng",
  delivered: "Đã giao hàng",
};

function shipment(o: OrderDetails): StatusBlock {
  const title = "Giao hàng";
  if (o.state === "cancelled" && o.shipmentState === "unfulfilled") {
    return { title, status: "Không giao (đơn đã hủy)", detail: null, tone: "neutral" };
  }
  return {
    title,
    status: SHIPMENT_LABELS[o.shipmentState],
    detail: `${o.address.line}, ${o.address.wardName}, ${o.address.provinceName}`,
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
