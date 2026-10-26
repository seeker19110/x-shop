import type { MedusaContainer } from "@medusajs/framework/types";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { issueOrderToken, safeEqual, tokenHash } from "./access";

/**
 * Tra cứu đơn bằng mã đơn + SĐT (POST01, AT20) với công việc ĐỒNG ĐỀU: dù mã đơn không tồn tại hay tồn tại nhưng sai
 * SĐT, tiến trình chạy CÙNG các bước theo cùng thứ tự — một truy vấn tìm đơn, một so sánh băm hằng thời gian (với giá
 * trị giả khi không có đơn), một lần ký liên kết — rồi trả cùng phản hồi. Chỉ khi khớp mới ghi outbox gửi liên kết;
 * bước đó cần biết cả mã đơn lẫn SĐT đúng (chính là bí mật cần bảo vệ) nên không mở thêm kênh dò tồn tại đơn.
 */

/** Ứng viên để so SĐT. Không có đơn → dùng ứng viên giả (`DUMMY_*`) để vẫn chạy đủ bước. */
export interface LookupCandidate {
  order_id: string;
  display_ref: string;
  phone: string;
}

/** Các bước có I/O hoặc tốn CPU của tra cứu — tách ra để test chứng minh hai nhánh "không khớp" chạy cùng bước. */
export interface LookupPorts {
  findByRef(ref: string): Promise<LookupCandidate | null>;
  phoneEquals(stored: string, given: string): boolean;
  issueLink(orderId: string, now: Date): { token: string; expires_at: string };
  deliverLink(candidate: LookupCandidate, link: { token: string; expires_at: string }): Promise<void>;
}

/** Không bao giờ trùng một SĐT đã chuẩn hoá (`0` + 9 chữ số) → ứng viên giả không thể khớp. */
export const DUMMY_LOOKUP_PHONE = "x-shop:no-order";
export const DUMMY_LOOKUP_ORDER_ID = "order_lookup_dummy";

/** Trả `true` nếu khớp (đã ghi outbox). Người gọi KHÔNG được đổi phản hồi theo giá trị này. */
export async function runOrderLookup(
  ports: LookupPorts,
  ref: string,
  phone: string,
  now: Date,
): Promise<boolean> {
  const found = await ports.findByRef(ref);
  const candidate = found ?? { order_id: DUMMY_LOOKUP_ORDER_ID, display_ref: ref, phone: DUMMY_LOOKUP_PHONE };
  // Luôn so (không short-circuit theo `found`) và luôn ký: hai nhánh không khớp tốn cùng công việc.
  const phoneOk = ports.phoneEquals(candidate.phone, phone);
  const link = ports.issueLink(candidate.order_id, now);
  const matched = found !== null && phoneOk;
  if (matched) await ports.deliverLink(found, link);
  return matched;
}

export function lookupPortsFor(container: MedusaContainer): LookupPorts {
  const s = container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
  return {
    async findByRef(ref) {
      const [fin] = await s.listOrderFinances({ display_ref: ref });
      if (!fin) return null;
      const phone = (fin.contact as { phone?: unknown } | null | undefined)?.phone;
      return {
        order_id: fin.order_id,
        display_ref: fin.display_ref,
        phone: typeof phone === "string" ? phone : "",
      };
    },
    phoneEquals: safeEqual,
    issueLink: (orderId, now) => issueOrderToken("link", orderId, now),
    async deliverLink(c, link) {
      await s.insertOutbox(
        `order.lookup_link:${c.order_id}:${tokenHash(link.token).slice(0, 24)}`,
        c.order_id,
        "order.lookup_link",
        {
          order_id: c.order_id,
          display_ref: c.display_ref,
          // Bên gửi (T-029) dựng URL `/tra-cuu-don/xac-thuc?token=…`; token một lần, 15 phút.
          token: link.token,
          expires_at: link.expires_at,
        },
      );
    },
  };
}
