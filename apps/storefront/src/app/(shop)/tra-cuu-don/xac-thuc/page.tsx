import type { Metadata } from "next";
import styles from "../../../../components/orders/Order.module.css";
import { Button } from "../../../../components/ui/Button";
import { redeemLinkAction } from "../../../../lib/orders/actions";
import { t } from "../../../../lib/i18n";

export const metadata: Metadata = {
  title: t("orders.viewTitle"),
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
        {t("orders.viewTitle")}
      </h1>
      {token ? (
        <form action={redeemLinkAction} className={styles.form}>
          <input type="hidden" name="token" value={token} />
          <p>{t("orders.redeemIntro")}</p>
          <Button type="submit">{t("orders.viewTitle")}</Button>
        </form>
      ) : (
        <>
          <p>{t("orders.redeemInvalid")}</p>
          <Button href="/tra-cuu-don">{t("orders.lookupTitle")}</Button>
        </>
      )}
    </section>
  );
}
