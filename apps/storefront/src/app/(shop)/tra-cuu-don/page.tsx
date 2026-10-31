import type { Metadata } from "next";
import styles from "../../../components/orders/Order.module.css";
import { LookupForm } from "../../../components/orders/LookupForm";
import { ORDER_REF_RE } from "../../../lib/orders/map";
import { isNonEmpty } from "../../../lib/presence";
import { lookupNotice } from "../../../lib/orders/notices";

export const metadata: Metadata = {
  title: "Tra cứu đơn hàng",
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
        Tra cứu đơn hàng
      </h1>
      {isNonEmpty(notice) ? <p className={styles.section}>{notice}</p> : null}
      <p>
        Vì lý do bảo mật, mã đơn và số điện thoại không đủ để hiển thị đơn. Chúng tôi sẽ gửi liên kết xem đơn
        (hiệu lực 15 phút, dùng một lần) tới số điện thoại/email đã dùng khi đặt hàng.
      </p>
      <LookupForm defaultRef={ORDER_REF_RE.test(ma) ? ma : ""} />
    </section>
  );
}
