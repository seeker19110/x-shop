import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderDetail } from "../../../../components/orders/OrderDetail";
import styles from "../../../../components/orders/Order.module.css";
import { Button } from "../../../../components/ui/Button";
import { ORDER_REF_RE } from "../../../../lib/orders/map";
import { fetchOrder } from "../../../../lib/orders/service";
import { t } from "../../../../lib/i18n";

export const metadata: Metadata = {
  title: t("orders.pageTitle"),
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
        {t("orders.heading")}
        <span className={styles.ref}>{ref}</span>
      </h1>
      {r.kind === "not_found" ? (
        <>
          <p>{t("orders.needAuth")}</p>
          <div className={styles.actions}>
            <Button href={`/tra-cuu-don?ma=${encodeURIComponent(ref)}`}>{t("orders.lookupTitle")}</Button>
          </div>
        </>
      ) : (
        <>
          <p role="alert" className={styles.alert}>
            {r.kind === "rate_limited"
              ? t("orders.rateLimited", { seconds: r.retryAfterS })
              : t("orders.loadFailed")}
          </p>
          <div className={styles.actions}>
            <Button href={`/don-hang/${encodeURIComponent(ref)}`} variant="secondary">
              {t("orders.reload")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
