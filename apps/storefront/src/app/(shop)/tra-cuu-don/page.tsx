import type { Metadata } from "next";
import styles from "../../../components/orders/Order.module.css";
import { LookupForm } from "../../../components/orders/LookupForm";
import { ORDER_REF_RE } from "../../../lib/orders/map";
import { isNonEmpty } from "../../../lib/presence";
import { lookupNotice } from "../../../lib/orders/notices";
import { t } from "../../../lib/i18n";

export const metadata: Metadata = {
  title: t("orders.lookupTitle"),
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

/** Tra cứu đơn (POST01): mã đơn + SĐT → luôn cùng thông điệp; liên kết xem đơn gửi qua email/SMS. */
export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ma = typeof sp.ma === "string" ? sp.ma.trim().toUpperCase() : "";
  const notice = lookupNotice(typeof sp.loi === "string" ? sp.loi : sp.tu);
  return (
    <section className={styles.page} aria-labelledby="tra-cuu-tieu-de">
      <h1 id="tra-cuu-tieu-de" className={styles.title}>
        {t("orders.lookupTitle")}
      </h1>
      {isNonEmpty(notice) ? <p className={styles.section}>{notice}</p> : null}
      <p>{t("orders.lookupIntro")}</p>
      <LookupForm defaultRef={ORDER_REF_RE.test(ma) ? ma : ""} />
    </section>
  );
}
