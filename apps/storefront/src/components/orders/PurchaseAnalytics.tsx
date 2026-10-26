"use client";

import { useEffect } from "react";
import type { AnalyticsPayload } from "../../lib/analytics/schema";
import { track } from "../../lib/analytics/track";

/**
 * Không render gì: bắn `purchase` một lần khi trang đơn hiện ra với đơn đủ điều kiện (`purchaseEventOf` tính ở server
 * — client chỉ nhận payload tối thiểu, không nhận cả đơn). Dedupe theo `order_id` nằm ở `track()`.
 */
export function PurchaseAnalytics({ event }: { event: AnalyticsPayload | null }) {
  const key = event ? `${event.order_id}|${event.value}` : "";
  useEffect(() => {
    if (event) track(event);
    // `key` đại diện cho nội dung sự kiện (tránh chạy lại khi object đổi tham chiếu).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy lại theo khoá ổn định đã liệt kê; thêm phụ thuộc còn lại gây lặp/gửi trùng sự kiện
  }, [key]);
  return null;
}
