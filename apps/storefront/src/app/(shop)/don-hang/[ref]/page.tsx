import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderDetail } from "../../../../components/orders/OrderDetail";
import styles from "../../../../components/orders/Order.module.css";
import { Button } from "../../../../components/ui/Button";
import { ORDER_REF_RE } from "../../../../lib/orders/map";
import { fetchOrder } from "../../../../lib/orders/service";

export const metadata: Metadata = {
  title: "Đơn hàng của bạn",
  robots: { index: false, follow: false },
};

/** Riêng tư theo cookie phiên đơn: luôn dựng ở server, không cache (header `private, no-store` ở next.config.ts). */
export const dynamic = "force-dynamic";

/**
 * Trang đơn (CHK06, POST01): token phiên đơn trong cookie HttpOnly → backend. Không có/không hợp lệ → hướng dẫn tra cứu
 * (không phân biệt đơn có tồn tại — AT20). Lỗi mạng/backend → báo chưa tải được, KHÔNG hiển thị trạng thái cũ hay
 * "đã thanh toán" (AT24).
 */
export default async function OrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  if (!ORDER_REF_RE.test(ref)) notFound();
  const r = await fetchOrder(ref);
  if (r.kind === "ok") return <OrderDetail order={r.order} />;
  return (
    <section className={styles.page} aria-labelledby="don-hang-tieu-de">
      <h1 id="don-hang-tieu-de" className={styles.title}>
        Đơn hàng <span className={styles.ref}>{ref}</span>
      </h1>
      {r.kind === "not_found" ? (
        <>
          <p>
            Bạn cần xác thực để xem đơn này. Nhập mã đơn và số điện thoại đặt hàng — chúng tôi sẽ gửi liên kết xem đơn tới
            liên hệ đã dùng khi đặt.
          </p>
          <div className={styles.actions}>
            <Button href={`/tra-cuu-don?ma=${encodeURIComponent(ref)}`}>Tra cứu đơn hàng</Button>
          </div>
        </>
      ) : (
        <>
          <p role="alert" className={styles.alert}>
            {r.kind === "rate_limited"
              ? `Bạn đã thao tác quá nhiều lần. Vui lòng thử lại sau ${r.retryAfterS} giây.`
              : "Chưa tải được trạng thái đơn hàng. Vui lòng kiểm tra kết nối và tải lại trang."}
          </p>
          <div className={styles.actions}>
            <Button href={`/don-hang/${encodeURIComponent(ref)}`} variant="secondary">
              Tải lại
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
