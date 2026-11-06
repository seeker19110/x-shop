"use client";

import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { t } from "../lib/i18n";

/**
 * Biên lỗi cấp trang (UX-STATE-005): chỉ thông điệp chung + đường thử lại. KHÔNG hiển thị `error.message`/stack/digest
 * (có thể chứa chi tiết nội bộ); chi tiết đã nằm ở log server.
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert">
      <EmptyState
        title={t("static.error.title")}
        description={t("static.error.description")}
        action={<Button onClick={reset}>{t("static.error.retry")}</Button>}
      />
    </div>
  );
}
