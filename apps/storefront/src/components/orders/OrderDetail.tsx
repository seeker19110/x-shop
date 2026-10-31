import { formatVnd } from "../../lib/format-vnd";
import { SELLER } from "../../lib/content/site";
import { formatOrderTime, presentOrder, type StatusBlock } from "../../lib/orders/present";
import type { OrderDetails } from "../../lib/orders/types";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { OrderActions } from "./OrderActions";
import { PurchaseAnalytics } from "./PurchaseAnalytics";
import { purchaseEventOf } from "./purchase-event";
import styles from "./Order.module.css";
import { isNonEmpty } from "../../lib/presence";
import { t } from "../../lib/i18n";

function Block({ block, id }: { block: StatusBlock; id: string }) {
  return (
    <li
      className={cx(
        styles.block,
        block.tone === "success" && styles.success,
        block.tone === "warning" && styles.warning,
      )}
      aria-labelledby={id}
    >
      <h2 id={id}>{block.title}</h2>
      <p className={styles.status}>{block.status}</p>
      {isNonEmpty(block.detail) ? <p>{block.detail}</p> : null}
    </li>
  );
}

/**
 * Trang chi tiết đơn (CHK06, POST01): ba khối Đặt đơn / Thanh toán / Giao hàng trình bày riêng + timeline, dòng hàng,
 * tổng tiền, mã tham chiếu và kênh hỗ trợ. Mọi trạng thái lấy từ server tại thời điểm dựng trang; đơn đã thanh toán /
 * COD đã xác nhận → sự kiện `purchase` (một lần mỗi đơn).
 */
export function OrderDetail({ order, now = new Date() }: { order: OrderDetails; now?: Date }) {
  const p = presentOrder(order, now);
  return (
    <section className={styles.page} aria-labelledby="don-hang-tieu-de">
      <PurchaseAnalytics event={purchaseEventOf(order)} />
      <div>
        <h1 id="don-hang-tieu-de" className={styles.title}>
          {t("orders.heading")}
          <span className={styles.ref}>{order.ref}</span>
        </h1>
        <p className={styles.muted}>
          {t("orders.detail.placedAt", { time: formatOrderTime(order.createdAt) })}
        </p>
      </div>

      <ul className={styles.blocks}>
        <Block block={p.placement} id="khoi-dat-don" />
        <Block block={p.payment} id="khoi-thanh-toan" />
        <Block block={p.shipment} id="khoi-giao-hang" />
      </ul>

      <OrderActions
        orderRef={order.ref}
        canRecheck={p.showRecheck}
        canCancel={order.canCancel}
        paid={order.paymentState === "paid"}
      />

      {p.showReorder ? (
        <div className={styles.section}>
          <h2>{t("orders.detail.reorderTitle")}</h2>
          <p>{t("orders.detail.reorderText")}</p>
          <div className={styles.actions}>
            <Button href="/tim-kiem" variant="secondary">
              {t("orders.detail.reorderButton")}
            </Button>
          </div>
        </div>
      ) : null}

      <section className={styles.section} aria-labelledby="tien-trinh">
        <h2 id="tien-trinh">{t("orders.detail.timelineTitle")}</h2>
        <ol className={styles.timeline}>
          {order.timeline.map((entry, i) => (
            <li key={`${entry.kind}-${i}`}>
              <time dateTime={entry.at}>{formatOrderTime(entry.at)}</time>
              {t("orders.detail.timelineSep")}
              {entry.label}
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="san-pham">
        <h2 id="san-pham">{t("orders.detail.productsTitle")}</h2>
        <ul className={styles.lines}>
          {order.lines.map((l, i) => (
            <li key={i} className={styles.line}>
              <span>
                {l.title}
                {isNonEmpty(l.variantTitle)
                  ? t("orders.detail.lineVariant", { variant: l.variantTitle })
                  : ""}
                {t("orders.detail.lineQuantity", { quantity: l.quantity })}
              </span>
              <span>{formatVnd(l.total)}</span>
            </li>
          ))}
        </ul>
        <dl className={styles.lines}>
          <div className={styles.totalRow}>
            <dt>{t("orders.detail.subtotal")}</dt>
            <dd>{formatVnd(order.totals.subtotal)}</dd>
          </div>
          {order.totals.discountTotal > 0 ? (
            <div className={styles.totalRow}>
              <dt>{t("orders.detail.discount")}</dt>
              <dd>{t("orders.detail.minusAmount", { amount: formatVnd(order.totals.discountTotal) })}</dd>
            </div>
          ) : null}
          <div className={styles.totalRow}>
            <dt>{t("orders.detail.shipping")}</dt>
            <dd>{formatVnd(order.totals.shippingTotal)}</dd>
          </div>
          <div className={cx(styles.totalRow, styles.grandTotal)}>
            <dt>{t("orders.detail.total")}</dt>
            <dd>{formatVnd(order.totals.total)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="nguoi-nhan">
        <h2 id="nguoi-nhan">{t("orders.detail.recipientTitle")}</h2>
        <p>{t("orders.detail.recipient", { name: order.contact.name, phone: order.contact.phone })}</p>
        <p>
          {t("orders.detail.address", {
            line: order.address.line,
            ward: order.address.wardName,
            province: order.address.provinceName,
          })}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="ho-tro">
        <h2 id="ho-tro">{t("orders.detail.supportTitle")}</h2>
        <p>
          {t("orders.detail.supportRef")}
          <strong>{order.ref}</strong>
          {t("orders.detail.supportContact", { contact: SELLER.contact })}
        </p>
      </section>
    </section>
  );
}
