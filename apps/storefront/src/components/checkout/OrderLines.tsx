import Image from "next/image";
import { formatVnd } from "../../lib/format-vnd";
import styles from "./Checkout.module.css";

export interface CheckoutLine {
  id: string;
  /** Handle sản phẩm (cho telemetry); null nếu dòng không còn gắn sản phẩm. */
  itemId?: string | null;
  title: string;
  variantLabel: string | null;
  quantity: number;
  lineTotal: number;
  thumbnail: { url: string; alt: string } | null;
}

/** Danh sách sản phẩm trong đơn (order summary). Không có id cố định để dùng được nhiều nơi. */
export function OrderLines({ lines }: { lines: readonly CheckoutLine[] }) {
  return (
    <ul className={styles.orderLines} aria-label="Sản phẩm trong đơn hàng">
      {lines.map((l) => (
        <li key={l.id} className={styles.orderLine}>
          <div className={styles.orderThumb}>
            {l.thumbnail ? (
              <Image src={l.thumbnail.url} alt={l.thumbnail.alt} width={56} height={70} />
            ) : null}
          </div>
          <div className={styles.orderInfo}>
            <p>{l.title}</p>
            {l.variantLabel ? <p className={styles.muted}>{l.variantLabel}</p> : null}
            <p className={styles.muted}>{`Số lượng: ${l.quantity}`}</p>
          </div>
          <p className={styles.orderPrice}>{formatVnd(l.lineTotal)}</p>
        </li>
      ))}
    </ul>
  );
}
