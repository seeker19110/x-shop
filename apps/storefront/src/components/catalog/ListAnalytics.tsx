"use client";

import { useEffect } from "react";
import { track } from "../../lib/analytics/track";
import { isNonEmpty } from "../../lib/presence";

/** `/san-pham/<handle>` → handle (đã giải mã); khác dạng → null. */
export function handleFromHref(href: string): string | null {
  const m = /^\/san-pham\/([^/?#]+)/.exec(href);
  if (!m || !isNonEmpty(m[1])) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export interface ListAnalyticsProps {
  /** Định danh danh sách: handle danh mục hoặc "tim-kiem". */
  listId: string;
  items: readonly { handle: string; price: number }[];
}

/**
 * Không render gì: gửi `view_item_list` khi danh sách hiện ra và `select_item` khi bấm vào thẻ sản phẩm
 * (ủy quyền sự kiện click — thẻ vẫn là Server Component, không thêm JS cho từng thẻ).
 */
export function ListAnalytics({ listId, items }: ListAnalyticsProps) {
  const key = items.map((i) => i.handle).join("|");

  useEffect(() => {
    if (items.length === 0) return;
    track({
      event: "view_item_list",
      list_id: listId,
      items: items.slice(0, 50).map((i) => ({ item_id: i.handle, price: i.price })),
    });
    const onClick = (e: MouseEvent) => {
      const a =
        e.target instanceof Element ? e.target.closest<HTMLAnchorElement>(".product-grid a[href]") : null;
      const handle = a ? handleFromHref(a.getAttribute("href") ?? "") : null;
      if (!isNonEmpty(handle)) return;
      const index = items.findIndex((i) => i.handle === handle);
      track({
        event: "select_item",
        list_id: listId,
        ...(index >= 0 ? { index } : {}),
        items: [{ item_id: handle, ...(index >= 0 ? { price: items[index]!.price } : {}) }],
      });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
    // `key` đại diện cho nội dung danh sách (tránh chạy lại khi mảng đổi tham chiếu nhưng cùng nội dung).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy lại theo khoá ổn định đã liệt kê; thêm phụ thuộc còn lại gây lặp/gửi trùng sự kiện
  }, [listId, key]);

  return null;
}
