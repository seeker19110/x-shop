import type { PaymentMethod, QuoteView } from "../../lib/checkout/types";
import { formatVnd } from "../../lib/format-vnd";
import styles from "./Checkout.module.css";

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cod: "Thanh toán khi nhận hàng (COD)",
  vnpay: "Thanh toán online qua VNPAY",
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
  const pending = quoting ? "Đang tính…" : "Nhập địa chỉ để tính";
  return (
    <dl className={styles.totals} aria-busy={quoting || undefined} data-testid="totals">
      <div>
        <dt>Tiền hàng</dt>
        <dd>{formatVnd(quote?.subtotal ?? cartSubtotal)}</dd>
      </div>
      {quote && quote.discountTotal > 0 ? (
        <div>
          <dt>{quote.discountCode ? `Giảm giá (mã ${quote.discountCode})` : "Giảm giá"}</dt>
          <dd>{`− ${formatVnd(quote.discountTotal)}`}</dd>
        </div>
      ) : null}
      <div>
        <dt>Phí vận chuyển</dt>
        <dd>{quote ? formatVnd(quote.shippingFee) : pending}</dd>
      </div>
      {quote && quote.shippingDiscount > 0 ? (
        <div>
          <dt>Giảm phí vận chuyển</dt>
          <dd>{`− ${formatVnd(quote.shippingDiscount)}`}</dd>
        </div>
      ) : null}
      <div className={styles.grand}>
        <dt>Tổng phải trả</dt>
        <dd>{quote ? formatVnd(quote.total) : pending}</dd>
      </div>
      <div>
        <dt>Thanh toán</dt>
        <dd>{PAYMENT_LABEL[method]}</dd>
      </div>
    </dl>
  );
}
