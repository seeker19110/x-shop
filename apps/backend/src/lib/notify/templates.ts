import { formatVnd, isNonEmpty } from "@x-shop/domain";

/**
 * Mẫu thông báo giao dịch tiếng Việt (T-029). Hàm thuần: dữ liệu vào → tiêu đề + nội dung (email) và bản ngắn (SMS,
 * không dấu để tránh tách nhiều tin). Không chèn dữ liệu nhạy cảm ngoài cái khách cần (mã đơn, tổng tiền, link).
 */
export const TEMPLATE_NAMES = [
  "order.placed",
  "order.confirmed",
  "order.lookup_link",
  "shipment.shipped",
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateData {
  name: string;
  display_ref: string;
  total?: number;
  /** Link tra cứu đơn có token ngắn hạn (S-308) — chỉ đi trong nội dung, không bao giờ vào log. */
  link?: string;
  tracking_code?: string | null;
}

export interface Rendered {
  subject: string;
  text: string;
  sms: string;
}

const SHOP = "x-shop";

export function renderTemplate(name: TemplateName, d: TemplateData): Rendered {
  const hello = `Chào ${d.name},`;
  const total = d.total !== undefined ? formatVnd(d.total) : null;
  switch (name) {
    case "order.placed":
      return {
        subject: `[${SHOP}] Đã nhận đơn ${d.display_ref} — thanh toán khi nhận hàng`,
        text: [
          hello,
          `${SHOP} đã nhận đơn ${d.display_ref}${isNonEmpty(total) ? ` (tổng ${total})` : ""}, thanh toán khi nhận hàng (COD).`,
          "Nhân viên sẽ gọi xác nhận trước khi giao. Vui lòng để ý điện thoại.",
        ].join("\n\n"),
        sms: `${SHOP}: Da nhan don ${d.display_ref}, thanh toan khi nhan hang. Shop se goi xac nhan truoc khi giao.`,
      };
    case "order.confirmed":
      return {
        subject: `[${SHOP}] Đơn ${d.display_ref} đã được xác nhận`,
        text: [
          hello,
          `Đơn ${d.display_ref}${isNonEmpty(total) ? ` (tổng ${total})` : ""} đã được xác nhận và đang được chuẩn bị.`,
          "Chúng tôi sẽ báo khi đơn được giao cho đơn vị vận chuyển.",
        ].join("\n\n"),
        sms: `${SHOP}: Don ${d.display_ref} da duoc xac nhan va dang chuan bi.`,
      };
    case "order.lookup_link": {
      if (!isNonEmpty(d.link)) throw new Error("order.lookup_link cần link");
      return {
        subject: `[${SHOP}] Link xem đơn ${d.display_ref}`,
        text: [
          hello,
          `Mở link sau để xem đơn ${d.display_ref} (link dùng một lần, hết hạn sau ít phút):`,
          d.link,
          "Nếu bạn không yêu cầu, hãy bỏ qua thư này.",
        ].join("\n\n"),
        sms: `${SHOP}: Xem don ${d.display_ref}: ${d.link}`,
      };
    }
    case "shipment.shipped":
      return {
        subject: `[${SHOP}] Đơn ${d.display_ref} đang được giao`,
        text: [
          hello,
          `Đơn ${d.display_ref} đã được giao cho Giao Hàng Nhanh${isNonEmpty(d.tracking_code) ? ` (mã vận đơn ${d.tracking_code})` : ""}.`,
          "Vui lòng để ý điện thoại để nhận hàng.",
        ].join("\n\n"),
        sms: `${SHOP}: Don ${d.display_ref} dang duoc giao${isNonEmpty(d.tracking_code) ? `, ma van don ${d.tracking_code}` : ""}.`,
      };
  }
}
