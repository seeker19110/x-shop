import { Skeleton } from "./Skeleton";
import { VisuallyHidden } from "./VisuallyHidden";
import styles from "./PageLoading.module.css";
import { t } from "../../lib/i18n";

/**
 * Khung chờ cấp trang cho `loading.tsx` (UX-STATE-001): tiêu đề + lưới thẻ cùng tỷ lệ với nội dung thật (DESIGN.md
 * §Skeleton — tránh CLS), vùng `aria-busy` kèm thông báo đọc được cho trình đọc màn hình.
 */
export function PageLoading({ hero = false }: { hero?: boolean }) {
  return (
    <div className={styles.page}>
      <div role="status">
        <VisuallyHidden>{t("ui.loading.content")}</VisuallyHidden>
      </div>
      <div className={styles.body} aria-busy="true" aria-hidden="true">
        {hero ? <Skeleton aspectRatio="16 / 9" /> : <Skeleton width="50%" height="2rem" />}
        <div className={styles.grid}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} aspectRatio="4 / 5" />
          ))}
        </div>
      </div>
    </div>
  );
}
