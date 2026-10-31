"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { cancelOrderAction, recheckOrderAction } from "../../lib/orders/actions";
import type { OrderResult } from "../../lib/orders/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import styles from "./Order.module.css";
import { t } from "../../lib/i18n";

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
      return t("orders.actions.network");
    case "rate_limited":
      return t("orders.actions.recheckWait", { seconds: r.retryAfterS });
    case "not_found":
      return t("orders.actions.sessionExpired");
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
              ? t("orders.actions.paidConfirmed")
              : t("orders.actions.notPaidYet"),
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
          text:
            r.refundRequested === true ? t("orders.actions.cancelledRefund") : t("orders.actions.cancelled"),
          error: false,
        });
        router.refresh();
      } else {
        setMessage({
          text:
            r.kind === "error" && r.code === "PAYMENT_PENDING"
              ? t("orders.actions.paymentPending")
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
            loadingLabel={t("orders.actions.rechecking")}
            disabled={busy !== null}
          >
            {t("orders.actions.recheck")}
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            ref={cancelBtn}
            variant="secondary"
            onClick={() => setConfirmOpen(true)}
            disabled={busy !== null}
          >
            {t("orders.actions.cancel")}
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={message?.error === true ? styles.alert : undefined}>
        {message?.text ?? ""}
      </p>
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("orders.actions.dialogTitle", { ref: orderRef })}
        returnFocusRef={cancelBtn}
      >
        <p>
          {t("orders.actions.dialogIntro")}
          <strong>{orderRef}</strong>
          {t("orders.actions.dialogWarn")}
        </p>
        <p>{paid ? t("orders.actions.dialogPaid") : t("orders.actions.dialogUnpaid")}</p>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            data-autofocus
            onClick={() => setConfirmOpen(false)}
            disabled={busy === "cancel"}
          >
            {t("orders.actions.keep")}
          </Button>
          <Button onClick={cancel} loading={busy === "cancel"} loadingLabel={t("orders.actions.cancelling")}>
            {t("orders.actions.confirmCancel")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
