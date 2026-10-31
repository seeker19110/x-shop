import type { PaymentMethod, QuoteView } from "../../lib/checkout/types";
import { formatVnd } from "../../lib/format-vnd";
import styles from "./Checkout.module.css";
import { isNonEmpty } from "../../lib/presence";
import { t } from "../../lib/i18n";

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cod: t("checkout.payment.cod"),
  vnpay: t("checkout.payment.vnpay"),
};

export interface TotalsProps {
  /** Tiền hàng do server trả cho giỏ — dùng khi chưa có báo giá. */
  cartSubtotal: number;
  quote: QuoteView | null;
  quoting: boolean;
  method: PaymentMethod;
}

/**
 * Khối tổng tiền đặt NGAY trước nút đặt hàng (CHK04): tiền hàng, từng loại giảm giá, phí vận chuyển, tổng phải trả,
 * phương thức thanh toán. Mọi con số do server báo giá; chưa có địa chỉ thì phí/tổng ghi rõ "chưa tính".
 */
export function Totals({ cartSubtotal, quote, quoting, method }: TotalsProps) {
  const pending = quoting ? t("checkout.totals.calculating") : t("checkout.totals.enterAddress");
  return (
    <dl className={styles.totals} aria-busy={quoting || undefined} data-testid="totals">
      <div>
        <dt>{t("checkout.totals.subtotal")}</dt>
        <dd>{formatVnd(quote?.subtotal ?? cartSubtotal)}</dd>
      </div>
      {quote && quote.discountTotal > 0 ? (
        <div>
          <dt>
            {isNonEmpty(quote.discountCode)
              ? t("checkout.totals.discountWithCode", { code: quote.discountCode })
              : t("checkout.totals.discount")}
          </dt>
          <dd>{t("checkout.totals.minus", { amount: formatVnd(quote.discountTotal) })}</dd>
        </div>
      ) : null}
      <div>
        <dt>{t("checkout.totals.shipping")}</dt>
        <dd>{quote ? formatVnd(quote.shippingFee) : pending}</dd>
      </div>
      {quote && quote.shippingDiscount > 0 ? (
        <div>
          <dt>{t("checkout.totals.shippingDiscount")}</dt>
          <dd>{t("checkout.totals.minus", { amount: formatVnd(quote.shippingDiscount) })}</dd>
        </div>
      ) : null}
      <div className={styles.grand}>
        <dt>{t("checkout.totals.grand")}</dt>
        <dd>{quote ? formatVnd(quote.total) : pending}</dd>
      </div>
      <div>
        <dt>{t("checkout.totals.method")}</dt>
        <dd>{PAYMENT_LABEL[method]}</dd>
      </div>
    </dl>
  );
}
