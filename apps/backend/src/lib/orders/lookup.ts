import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { safeEqual } from "./access";

/**
 * Tra cứu đơn bằng mã đơn + SĐT (POST01, AT20) với công việc ĐỒNG ĐỀU: dù mã đơn không tồn tại hay tồn tại nhưng sai
 * SĐT, tiến trình chạy CÙNG các bước theo cùng thứ tự — một truy vấn tìm đơn, một so sánh băm hằng thời gian (với giá
 * trị giả khi không có đơn) — rồi trả cùng phản hồi. Chỉ khi khớp mới ghi outbox gửi liên kết; bước đó cần biết cả mã
 * đơn lẫn SĐT đúng (chính là bí mật cần bảo vệ) nên không mở thêm kênh dò tồn tại đơn.
 *
 * T-149 (D-089): outbox chỉ chứa ID (`order_id`, `display_ref`) — token liên kết một lần được phát hành LÚC GỬI ở bộ xử
 * lý thông báo (lib/notify), không bao giờ nằm trong bảng outbox. Vì thế tra cứu không còn bước ký token.
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
  /** Ghi outbox `order.lookup_link` (chỉ ID); bộ xử lý thông báo phát hành token + gửi. */
  deliverLink(candidate: LookupCandidate): Promise<void>;
}

/** Không bao giờ trùng một SĐT đã chuẩn hoá (`0` + 9 chữ số) → ứng viên giả không thể khớp. */
export const DUMMY_LOOKUP_PHONE = "x-shop:no-order";
export const DUMMY_LOOKUP_ORDER_ID = "order_lookup_dummy";

/** Trả `true` nếu khớp (đã ghi outbox). Người gọi KHÔNG được đổi phản hồi theo giá trị này. */
export async function runOrderLookup(ports: LookupPorts, ref: string, phone: string): Promise<boolean> {
  const found = await ports.findByRef(ref);
  const candidate = found ?? { order_id: DUMMY_LOOKUP_ORDER_ID, display_ref: ref, phone: DUMMY_LOOKUP_PHONE };
  // Luôn so (không short-circuit theo `found`): hai nhánh không khớp tốn cùng công việc.
  const phoneOk = ports.phoneEquals(candidate.phone, phone);
  const matched = found !== null && phoneOk;
  if (matched) await ports.deliverLink(found);
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
    async deliverLink(c) {
      // Mỗi lần tra cứu khớp = một thư (đã giới hạn 5/giờ/SĐT, 10/giờ/mã đơn); khoá ngẫu nhiên, không suy ra từ token.
      await s.insertOutbox(
        `order.lookup_link:${c.order_id}:${randomUUID()}`,
        c.order_id,
        "order.lookup_link",
        {
          order_id: c.order_id,
          display_ref: c.display_ref,
        },
      );
    },
  };
}
