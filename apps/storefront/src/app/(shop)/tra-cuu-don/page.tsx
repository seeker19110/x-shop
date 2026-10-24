import type { Metadata } from "next";
import styles from "../../../components/orders/Order.module.css";
import { LookupForm } from "../../../components/orders/LookupForm";
import { ORDER_REF_RE } from "../../../lib/orders/map";

export const metadata: Metadata = {
  title: "Tra cứu đơn hàng",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  "lien-ket": "Liên kết xem đơn đã hết hạn hoặc đã được dùng. Vui lòng tra cứu lại để nhận liên kết mới.",
  "thanh-toan":
    "Chúng tôi đang xác nhận thanh toán với cổng VNPAY — bạn không cần thanh toán lại. Tra cứu đơn để xem kết quả.",
};

/** Tra cứu đơn (POST01): mã đơn + SĐT → luôn cùng thông điệp; liên kết xem đơn gửi qua email/SMS. */
export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ma = typeof sp.ma === "string" ? sp.ma.trim().toUpperCase() : "";
  const notice = typeof sp.loi === "string" ? NOTICES[sp.loi] : typeof sp.tu === "string" ? NOTICES[sp.tu] : undefined;
  return (
    <section className={styles.page} aria-labelledby="tra-cuu-tieu-de">
      <h1 id="tra-cuu-tieu-de" className={styles.title}>
        Tra cứu đơn hàng
      </h1>
      {notice ? <p className={styles.section}>{notice}</p> : null}
      <p>
        Vì lý do bảo mật, mã đơn và số điện thoại không đủ để hiển thị đơn. Chúng tôi sẽ gửi liên kết xem đơn (hiệu lực 15
        phút, dùng một lần) tới số điện thoại/email đã dùng khi đặt hàng.
      </p>
      <LookupForm defaultRef={ORDER_REF_RE.test(ma) ? ma : ""} />
    </section>
  );
}
