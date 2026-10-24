import type { Metadata } from "next";
import styles from "../../../../components/orders/Order.module.css";
import { Button } from "../../../../components/ui/Button";
import { redeemLinkAction } from "../../../../lib/orders/actions";

export const metadata: Metadata = {
  title: "Xem đơn hàng",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * Đích của liên kết tra cứu `/tra-cuu-don/xac-thuc?token=…` (POST01). Trang KHÔNG tự đổi token khi GET (trình quét
 * liên kết của email/SMS sẽ tiêu mất liên kết một lần); khách bấm nút → Server Action đổi token thành cookie phiên đơn
 * rồi chuyển tới `/don-hang/:ref` — URL đích không chứa token. `Referrer-Policy: no-referrer` (next.config.ts + meta)
 * để token không rò qua Referer.
 */
export default async function RedeemPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" && sp.token.length <= 512 ? sp.token : "";
  return (
    <section className={styles.page} aria-labelledby="xac-thuc-tieu-de">
      <h1 id="xac-thuc-tieu-de" className={styles.title}>
        Xem đơn hàng
      </h1>
      {token ? (
        <form action={redeemLinkAction} className={styles.form}>
          <input type="hidden" name="token" value={token} />
          <p>Bấm nút dưới đây để mở đơn hàng của bạn trên thiết bị này.</p>
          <Button type="submit">Xem đơn hàng</Button>
        </form>
      ) : (
        <>
          <p>Liên kết không hợp lệ.</p>
          <Button href="/tra-cuu-don">Tra cứu đơn hàng</Button>
        </>
      )}
    </section>
  );
}
