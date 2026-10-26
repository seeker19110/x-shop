"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { cancelOrderAction, recheckOrderAction } from "../../lib/orders/actions";
import type { OrderResult } from "../../lib/orders/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import styles from "./Order.module.css";

export interface OrderActionsProps {
  orderRef: string;
  canRecheck: boolean;
  canCancel: boolean;
  paid: boolean;
}

/** Thông điệp cho kết quả KHÔNG thành công — không bao giờ khẳng định "đã thanh toán" khi chưa có xác nhận server. */
function failureMessage(r: OrderResult): string {
  switch (r.kind) {
    case "network":
      return "Mất kết nối — chưa xác định được kết quả. Vui lòng kiểm tra mạng rồi thử lại.";
    case "rate_limited":
      return `Bạn vừa kiểm tra xong. Vui lòng thử lại sau ${r.retryAfterS} giây.`;
    case "not_found":
      return "Phiên xem đơn đã hết hạn. Vui lòng tra cứu lại đơn hàng.";
    case "error":
      return r.message;
    default:
      return "";
  }
}

/**
 * "Kiểm tra lại" (S-104: server hỏi cổng về CÙNG giao dịch, không mời trả tiền lần nữa) và "Hủy đơn" có hộp thoại xác
 * nhận (POST02). Sau mỗi thao tác, trang dựng lại từ server — client không tự đổi trạng thái hiển thị.
 */
export function OrderActions({ orderRef, canRecheck, canCancel, paid }: OrderActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<"recheck" | "cancel" | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  if (!canRecheck && !canCancel) return null;

  const recheck = async () => {
    setBusy("recheck");
    setMessage(null);
    try {
      const r = await recheckOrderAction(orderRef);
      if (r.kind === "ok") {
        setMessage({
          text:
            r.order.paymentState === "paid"
              ? "Đã xác nhận thanh toán."
              : "Chưa có xác nhận thanh toán từ cổng. Nếu bạn đã thanh toán, vui lòng chờ thêm ít phút rồi kiểm tra lại.",
          error: false,
        });
        router.refresh();
      } else {
        setMessage({ text: failureMessage(r), error: true });
      }
    } catch {
      setMessage({ text: failureMessage({ kind: "network" }), error: true });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    setMessage(null);
    try {
      const r = await cancelOrderAction(orderRef);
      setConfirmOpen(false);
      if (r.kind === "ok") {
        setMessage({
          text: r.refundRequested
            ? "Đơn đã được hủy. Chúng tôi đã ghi nhận yêu cầu hoàn tiền và sẽ liên hệ với bạn."
            : "Đơn đã được hủy.",
          error: false,
        });
        router.refresh();
      } else {
        setMessage({
          text:
            r.kind === "error" && r.code === "PAYMENT_PENDING"
              ? "Đang xác nhận thanh toán với cổng nên chưa hủy được. Vui lòng thử lại sau ít phút."
              : failureMessage(r),
          error: true,
        });
      }
    } catch {
      setConfirmOpen(false);
      setMessage({ text: failureMessage({ kind: "network" }), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.actions}>
        {canRecheck ? (
          <Button
            onClick={recheck}
            loading={busy === "recheck"}
            loadingLabel="Đang kiểm tra"
            disabled={busy !== null}
          >
            Kiểm tra lại
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            ref={cancelBtn}
            variant="secondary"
            onClick={() => setConfirmOpen(true)}
            disabled={busy !== null}
          >
            Hủy đơn
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={message?.error ? styles.alert : undefined}>
        {message?.text ?? ""}
      </p>
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Hủy đơn ${orderRef}?`}
        returnFocusRef={cancelBtn}
      >
        <p>
          Bạn sắp hủy đơn <strong>{orderRef}</strong>. Thao tác này không thể hoàn tác.
        </p>
        <p>
          {paid
            ? "Đơn đã được thanh toán. Sau khi hủy, chúng tôi sẽ hoàn tiền theo chính sách hoàn tiền."
            : "Sau khi hủy, hàng giữ cho đơn sẽ được trả lại kho và không thể khôi phục đơn này."}
        </p>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            data-autofocus
            onClick={() => setConfirmOpen(false)}
            disabled={busy === "cancel"}
          >
            Giữ đơn
          </Button>
          <Button onClick={cancel} loading={busy === "cancel"} loadingLabel="Đang hủy">
            Xác nhận hủy
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
