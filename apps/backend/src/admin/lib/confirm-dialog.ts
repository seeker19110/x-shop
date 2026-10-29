import { formatVnd } from "./format";

/**
 * Nội dung hộp thoại xác nhận cho hành động không hoàn tác trên Admin (UX-STATE-008) — thuần, không phụ thuộc React.
 * Nêu đối tượng (mã đơn/yêu cầu, số tiền nếu có) + hậu quả; nhãn nút xác nhận là động từ của hành động (không "OK/Có").
 */
export type ConfirmKind = "refund-execute" | "order-cancel-unverified" | "refund-reject" | "return-reject";

export interface ConfirmSubject {
  /** Mã hiển thị của đối tượng (mã đơn hoặc mã yêu cầu). Rỗng/thiếu → "(không rõ mã)", không bịa. */
  ref: string | null | undefined;
  /** Số tiền VND nguyên (nếu hành động liên quan tiền). `null`/không hợp lệ → không in số. */
  amount?: number | null;
}

export interface ConfirmSpec {
  title: string;
  /** Câu nêu đối tượng. */
  object: string;
  /** Câu nêu hậu quả. */
  consequence: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Hành động phá huỷ/không hoàn tác → nút xác nhận dùng kiểu nguy hiểm. */
  destructive: boolean;
}

const CANCEL_LABEL = "Hủy bỏ";

function refOf(ref: string | null | undefined): string {
  const t = typeof ref === "string" ? ref.trim() : "";
  return t === "" ? "(không rõ mã)" : t;
}

function hasAmount(a: number | null | undefined): a is number {
  return typeof a === "number" && Number.isSafeInteger(a) && a >= 0;
}

export function confirmSpec(kind: ConfirmKind, subject: ConfirmSubject): ConfirmSpec {
  const ref = refOf(subject.ref);
  const money = hasAmount(subject.amount) ? formatVnd(subject.amount) : "";
  switch (kind) {
    case "refund-execute":
      return {
        title: "Xác nhận thực hiện hoàn tiền",
        object: `Yêu cầu hoàn ${ref}${money !== "" ? ` — số tiền ${money}` : ""}.`,
        consequence:
          "Tiền sẽ được hoàn cho khách và không thể hoàn tác. Thử lại dùng cùng mã yêu cầu nên không hoàn trùng.",
        confirmLabel: money !== "" ? `Hoàn tiền ${money}` : "Hoàn tiền",
        cancelLabel: CANCEL_LABEL,
        destructive: true,
      };
    case "order-cancel-unverified":
      return {
        title: "Xác nhận hủy đơn chưa xác minh",
        object: `Đơn ${ref} chưa được xác minh.`,
        consequence: "Đơn bị hủy, tồn kho giữ cho đơn được nhả và không thể khôi phục đơn này.",
        confirmLabel: "Hủy đơn",
        cancelLabel: CANCEL_LABEL,
        destructive: true,
      };
    case "refund-reject":
      return {
        title: "Xác nhận từ chối yêu cầu hoàn tiền",
        object: `Yêu cầu hoàn ${ref}${money !== "" ? ` — số tiền ${money}` : ""}.`,
        consequence: "Yêu cầu bị từ chối và ghi lý do; khách không nhận khoản hoàn này. Không thể hoàn tác.",
        confirmLabel: "Từ chối",
        cancelLabel: CANCEL_LABEL,
        destructive: true,
      };
    case "return-reject":
      return {
        title: "Xác nhận từ chối yêu cầu đổi trả",
        object: `Yêu cầu đổi trả ${ref}.`,
        consequence: "Yêu cầu bị từ chối và khách không được đổi trả theo yêu cầu này. Không thể hoàn tác.",
        confirmLabel: "Từ chối",
        cancelLabel: CANCEL_LABEL,
        destructive: true,
      };
  }
}
