"use client";

import type { CatalogFilter } from "@x-shop/domain";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Facets } from "../../lib/catalog/types";
import { Button } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { FilterFields } from "./FilterFields";
import { hrefFor, serializeQuery, withoutConditions } from "./filter-url";
import styles from "./Filters.module.css";

export interface FilterDrawerProps {
  basePath: string;
  /** Bộ lọc ĐÃ CHỐT (từ URL). Nháp trong drawer không đổi gì cho tới khi bấm "Xem N sản phẩm". */
  applied: CatalogFilter;
  facets: Facets | null;
  /** Tổng kết quả của bộ lọc đã chốt. */
  total: number;
  /** Số điều kiện đang áp, hiện ở nhãn nút "Bộ lọc (N)". */
  activeCount: number;
  /** Phạm vi danh mục (nếu có) khi đếm kết quả nháp. */
  category?: string | null;
}

const DEBOUNCE_MS = 250;
const keyOf = (f: CatalogFilter) => serializeQuery({ ...f, page: 1 });

export function FilterDrawer({ basePath, applied, facets, total, activeCount, category }: FilterDrawerProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CatalogFilter>(applied);
  const [counted, setCounted] = useState<{ key: string; total: number } | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const draftKey = keyOf(draft);
  const unchanged = draftKey === keyOf(applied);
  // N hiển thị: bộ lọc đã chốt dùng số có sẵn; nháp thì dùng kết quả đếm gần nhất khớp đúng nháp hiện tại.
  const shown = unchanged ? total : counted?.key === draftKey ? counted.total : null;

  useEffect(() => {
    if (!open || unchanged) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams(draftKey);
        if (category) qs.set("category", category);
        const res = await fetch(`/api/catalog/count?${qs.toString()}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { total?: unknown };
        if (typeof body.total === "number") setCounted({ key: draftKey, total: body.total });
      } catch {
        // Hủy/lỗi mạng: giữ nhãn trung tính "Xem kết quả" — nút vẫn áp dụng được.
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, unchanged, draftKey, category]);

  const close = () => setOpen(false); // hủy: bỏ nháp, KHÔNG đổi URL
  const apply = () => {
    setOpen(false);
    router.push(hrefFor(basePath, { ...draft, page: 1 }));
  };

  return (
    <>
      <Button
        ref={openerRef}
        variant="secondary"
        className={styles.openButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setDraft(applied); // luôn bắt đầu từ trạng thái đã chốt
          setOpen(true);
        }}
      >
        {`Bộ lọc (${activeCount})`}
      </Button>
      <Drawer
        open={open}
        onClose={close}
        title="Bộ lọc"
        side="bottom"
        returnFocusRef={openerRef}
        closeLabel="Đóng bộ lọc"
      >
        <FilterFields idPrefix="dr" facets={facets} value={draft} onChange={setDraft} />
        <div className={styles.drawerFooter}>
          <Button size="lg" fullWidth onClick={apply}>
            {shown === null ? "Xem kết quả" : `Xem ${shown} sản phẩm`}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(withoutConditions(draft, { keepQuery: true }))}>
            Xóa lựa chọn trong bộ lọc
          </Button>
        </div>
      </Drawer>
    </>
  );
}
