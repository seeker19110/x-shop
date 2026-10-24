import { formatVnd } from "../../lib/format-vnd";
import { SELLER } from "../../lib/content/site";
import { formatOrderTime, presentOrder, type StatusBlock } from "../../lib/orders/present";
import type { OrderDetails } from "../../lib/orders/types";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { OrderActions } from "./OrderActions";
import styles from "./Order.module.css";

function Block({ block, id }: { block: StatusBlock; id: string }) {
  return (
    <li
      className={cx(styles.block, block.tone === "success" && styles.success, block.tone === "warning" && styles.warning)}
      aria-labelledby={id}
    >
      <h2 id={id}>{block.title}</h2>
      <p className={styles.status}>{block.status}</p>
      {block.detail ? <p>{block.detail}</p> : null}
    </li>
  );
}

/**
 * Trang chi tiết đơn (CHK06, POST01): ba khối Đặt đơn / Thanh toán / Giao hàng trình bày riêng + timeline, dòng hàng,
 * tổng tiền, mã tham chiếu và kênh hỗ trợ. Mọi trạng thái lấy từ server tại thời điểm dựng trang.
 */
export function OrderDetail({ order, now = new Date() }: { order: OrderDetails; now?: Date }) {
  const p = presentOrder(order, now);
  return (
    <section className={styles.page} aria-labelledby="don-hang-tieu-de">
      <div>
        <h1 id="don-hang-tieu-de" className={styles.title}>
          Đơn hàng <span className={styles.ref}>{order.ref}</span>
        </h1>
        <p className={styles.muted}>Đặt lúc {formatOrderTime(order.createdAt)}</p>
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
          <h2>Đặt lại đơn</h2>
          <p>
            Hàng giữ cho đơn này đã được trả về kho. Bạn có thể chọn lại sản phẩm và đặt đơn mới — giá và tồn kho sẽ được
            kiểm tra lại trước khi bạn xác nhận.
          </p>
          <div className={styles.actions}>
            <Button href="/tim-kiem" variant="secondary">
              Chọn lại sản phẩm
            </Button>
          </div>
        </div>
      ) : null}

      <section className={styles.section} aria-labelledby="tien-trinh">
        <h2 id="tien-trinh">Tiến trình</h2>
        <ol className={styles.timeline}>
          {order.timeline.map((t, i) => (
            <li key={`${t.kind}-${i}`}>
              <time dateTime={t.at}>{formatOrderTime(t.at)}</time> — {t.label}
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="san-pham">
        <h2 id="san-pham">Sản phẩm</h2>
        <ul className={styles.lines}>
          {order.lines.map((l, i) => (
            <li key={i} className={styles.line}>
              <span>
                {l.title}
                {l.variantTitle ? ` — ${l.variantTitle}` : ""} × {l.quantity}
              </span>
              <span>{formatVnd(l.total)}</span>
            </li>
          ))}
        </ul>
        <dl className={styles.lines}>
          <div className={styles.totalRow}>
            <dt>Tạm tính</dt>
            <dd>{formatVnd(order.totals.subtotal)}</dd>
          </div>
          {order.totals.discountTotal > 0 ? (
            <div className={styles.totalRow}>
              <dt>Giảm giá</dt>
              <dd>−{formatVnd(order.totals.discountTotal)}</dd>
            </div>
          ) : null}
          <div className={styles.totalRow}>
            <dt>Phí giao hàng</dt>
            <dd>{formatVnd(order.totals.shippingTotal)}</dd>
          </div>
          <div className={cx(styles.totalRow, styles.grandTotal)}>
            <dt>Tổng cộng</dt>
            <dd>{formatVnd(order.totals.total)}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="nguoi-nhan">
        <h2 id="nguoi-nhan">Người nhận</h2>
        <p>
          {order.contact.name} · {order.contact.phone}
        </p>
        <p>
          {order.address.line}, {order.address.wardName}, {order.address.provinceName}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="ho-tro">
        <h2 id="ho-tro">Cần hỗ trợ?</h2>
        <p>
          Mã tham chiếu đơn: <strong>{order.ref}</strong>. Liên hệ: {SELLER.contact}.
        </p>
      </section>
    </section>
  );
}
