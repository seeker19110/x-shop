import type { Metadata } from "next";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { t } from "../../lib/i18n";

export const metadata: Metadata = {
  title: t("static.offline.title"),
  robots: { index: false, follow: false },
};

/** Trang dự phòng khi mất mạng (service worker trả khi điều hướng thất bại). Tĩnh, không đọc dữ liệu riêng tư. */
export default function OfflinePage() {
  return (
    <>
      <h1 className="visually-hidden">{t("static.offline.title")}</h1>
      <EmptyState
        title={t("static.offline.emptyTitle")}
        description={t("static.offline.emptyDescription")}
        action={<Button href="/">{t("static.offline.retry")}</Button>}
      />
    </>
  );
}
