"use client";

import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

/**
 * Biên lỗi cấp trang (UX-STATE-005): chỉ thông điệp chung + đường thử lại. KHÔNG hiển thị `error.message`/stack/digest
 * (có thể chứa chi tiết nội bộ); chi tiết đã nằm ở log server.
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert">
      <EmptyState
        title="Đã có sự cố"
        description="Có sự cố tạm thời khi tải trang này. Vui lòng thử lại; nếu vẫn lỗi, hãy quay lại sau ít phút."
        action={<Button onClick={reset}>Thử lại</Button>}
      />
    </div>
  );
}
