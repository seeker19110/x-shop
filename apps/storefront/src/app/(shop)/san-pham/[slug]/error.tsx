"use client";

import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { t } from "../../../../lib/i18n";

/** Lỗi tải sản phẩm (nguồn dữ liệu tạm lỗi): trang nhẹ, có đường thử lại — không lộ chi tiết lỗi. */
export default function ProductError({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState
      title={t("product.error.title")}
      description={t("product.error.description")}
      action={<Button onClick={reset}>{t("product.error.retry")}</Button>}
    />
  );
}
