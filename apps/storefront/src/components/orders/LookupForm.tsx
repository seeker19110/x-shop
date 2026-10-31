"use client";

import { useActionState } from "react";
import { lookupOrderAction } from "../../lib/orders/actions";
import type { LookupState } from "../../lib/orders/types";
import { Button } from "../ui/Button";
import styles from "./Order.module.css";
import { isNonEmpty } from "../../lib/presence";

const INITIAL: LookupState = { status: "idle" };

/**
 * Tra cứu đơn bằng mã đơn + SĐT (POST01): luôn nhận cùng một thông điệp — form không bao giờ cho biết đơn có tồn tại;
 * liên kết xem đơn được gửi tới liên hệ đã dùng khi đặt.
 */
export function LookupForm({ defaultRef = "" }: { defaultRef?: string }) {
  const [state, action, pending] = useActionState(lookupOrderAction, INITIAL);
  const refError = state.status === "invalid" && state.field === "ref" ? state.message : null;
  const phoneError = state.status === "invalid" && state.field === "phone" ? state.message : null;
  return (
    <form action={action} className={styles.form} noValidate>
      <div className={styles.field}>
        <label htmlFor="tra-cuu-ma">Mã đơn hàng</label>
        <input
          id="tra-cuu-ma"
          name="ma"
          defaultValue={defaultRef}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="XS-ABC123"
          required
          maxLength={32}
          aria-invalid={isNonEmpty(refError) ? true : undefined}
          aria-describedby={isNonEmpty(refError) ? "tra-cuu-ma-loi" : undefined}
        />
        {isNonEmpty(refError) ? (
          <p id="tra-cuu-ma-loi" className={styles.alert}>
            {refError}
          </p>
        ) : null}
      </div>
      <div className={styles.field}>
        <label htmlFor="tra-cuu-sdt">Số điện thoại đặt hàng</label>
        <input
          id="tra-cuu-sdt"
          name="sdt"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          maxLength={32}
          aria-invalid={isNonEmpty(phoneError) ? true : undefined}
          aria-describedby={isNonEmpty(phoneError) ? "tra-cuu-sdt-loi" : undefined}
        />
        {isNonEmpty(phoneError) ? (
          <p id="tra-cuu-sdt-loi" className={styles.alert}>
            {phoneError}
          </p>
        ) : null}
      </div>
      <Button type="submit" loading={pending} loadingLabel="Đang gửi">
        Gửi liên kết xem đơn
      </Button>
      <p role="status" aria-live="polite" className={state.status === "sent" ? styles.notice : undefined}>
        {state.status === "sent" ? state.message : ""}
      </p>
      {state.status === "rate_limited" || state.status === "error" ? (
        <p role="alert" className={styles.alert}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
