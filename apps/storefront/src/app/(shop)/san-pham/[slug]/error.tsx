"use client";

import { Button } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";

/** Lỗi tải sản phẩm (nguồn dữ liệu tạm lỗi): trang nhẹ, có đường thử lại — không lộ chi tiết lỗi. */
export default function ProductError({ reset }: { error: Error; reset: () => void }) {
  return (
    <EmptyState
      title="Không tải được sản phẩm"
      description="Có sự cố tạm thời khi tải thông tin sản phẩm. Vui lòng thử lại."
      action={<Button onClick={reset}>Thử lại</Button>}
    />
  );
}
