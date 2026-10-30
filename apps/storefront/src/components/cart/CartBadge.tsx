"use client";

import { useEffect, useState } from "react";
import { CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS, clientFetch } from "../../lib/client-fetch";
import { CART_CHANGED_EVENT } from "../../lib/cart/events";

/**
 * Số lượng giỏ ở header. Trang vẫn tĩnh/cache được: số được lấy sau khi tải từ `/api/cart/count` (private, no-store)
 * và cập nhật ngay khi có sự kiện `xs:cart-changed` (thêm/xóa/sửa). Lỗi mạng → giữ số hiện có.
 */
export function CartBadge({ initial = 0, className }: { initial?: number; className?: string }) {
  const [count, setCount] = useState(initial);

  useEffect(() => {
    const ctrl = new AbortController();
    clientFetch(
      "/api/cart/count",
      { cache: "no-store", credentials: "same-origin", signal: ctrl.signal },
      { maxRetries: 1, timeoutMs: CLIENT_FETCH_INTERACTIVE_TIMEOUT_MS },
    )
      .then((r) => (r.ok ? (r.json() as Promise<{ count?: number }>) : null))
      .then((j) => {
        if (!ctrl.signal.aborted && j && Number.isInteger(j.count)) setCount(j.count as number);
      })
      .catch(() => undefined);
    const onChange = (e: Event) => {
      const c = (e as CustomEvent<{ count?: number }>).detail?.count;
      if (Number.isInteger(c)) setCount(c as number);
    };
    window.addEventListener(CART_CHANGED_EVENT, onChange);
    return () => {
      ctrl.abort();
      window.removeEventListener(CART_CHANGED_EVENT, onChange);
    };
  }, []);

  return (
    <>
      <span aria-hidden="true" className={className}>
        {count}
      </span>
      <span className="visually-hidden">{`Giỏ hàng, ${count} sản phẩm`}</span>
    </>
  );
}
