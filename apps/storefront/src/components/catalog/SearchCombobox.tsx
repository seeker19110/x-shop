"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { fetchWithRetry } from "../../lib/http/retry";
import { Button } from "../ui/Button";
import styles from "./CatalogView.module.css";
import {
  SUGGEST_DEBOUNCE_MS,
  moveActive,
  normalizeTyped,
  sanitizeSuggestions,
  shouldSuggest,
} from "./search-suggest";

export interface SearchComboboxProps {
  defaultValue: string | null;
  /** Giới hạn độ dài truy vấn (CAT01: 100) — server truyền vào vì client không import giá trị từ domain. */
  maxLength: number;
}

/**
 * Ô tìm kiếm có gợi ý khi gõ — mẫu ARIA 1.2 "combobox với listbox, autocomplete=list". Vẫn là `<form method="get">`
 * nên chạy được khi chưa có JS. Gợi ý lấy sau debounce 250 ms từ `/api/catalog/suggest` (tối đa 8, truy vấn ≤ 100 ký
 * tự); phản hồi cũ/đã hủy không ghi đè kết quả mới. Phím: ↓/↑ chọn (quay vòng), Enter tìm theo gợi ý đang chọn,
 * Esc đóng. Focus luôn ở ô nhập (aria-activedescendant).
 */
export function SearchCombobox({ defaultValue, maxLength }: SearchComboboxProps) {
  const uid = useId();
  const listId = `${uid}-goi-y`;
  const optionId = (i: number) => `${uid}-goi-y-${i}`;
  const [items, setItems] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      abort.current?.abort();
    },
    [],
  );

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const schedule = (raw: string) => {
    clearTimeout(timer.current);
    abort.current?.abort();
    const q = normalizeTyped(raw, maxLength);
    if (!shouldSuggest(q)) {
      setItems([]);
      close();
      return;
    }
    timer.current = setTimeout(async () => {
      const ctrl = new AbortController();
      abort.current = ctrl;
      try {
        const res = await fetchWithRetry(
          `/api/catalog/suggest?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
          { maxRetries: 1 },
        );
        if (!res.ok || ctrl.signal.aborted) return;
        const list = sanitizeSuggestions(await res.json());
        if (ctrl.signal.aborted) return;
        setItems(list);
        setActive(-1);
        setOpen(list.length > 0);
      } catch {
        // mạng lỗi/hủy: chỉ đóng gợi ý, tìm kiếm thường vẫn dùng được
        if (!ctrl.signal.aborted) close();
      }
    }, SUGGEST_DEBOUNCE_MS);
  };

  const choose = (i: number) => {
    const text = items[i];
    if (text === undefined || !inputRef.current) return;
    inputRef.current.value = text;
    close();
    formRef.current?.requestSubmit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => moveActive(open ? a : -1, e.key as "ArrowDown" | "ArrowUp", items.length));
    } else if (e.key === "Enter") {
      if (open && active >= 0) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
    }
  };

  return (
    <form ref={formRef} role="search" method="get" action="/tim-kiem" className={styles.searchForm}>
      <label htmlFor={`${uid}-q`} className={styles.searchLabel}>
        Tìm theo tên, mã SKU hoặc danh mục
      </label>
      <div className={styles.searchRow}>
        <div className={styles.comboWrap}>
          <input
            ref={inputRef}
            id={`${uid}-q`}
            type="search"
            name="q"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
            defaultValue={defaultValue ?? ""}
            maxLength={maxLength}
            autoComplete="off"
            enterKeyHint="search"
            className={styles.searchInput}
            onChange={(e) => schedule(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={close}
          />
          <ul
            id={listId}
            role="listbox"
            aria-label="Gợi ý tìm kiếm"
            className={styles.suggestList}
            hidden={!open}
          >
            {open
              ? items.map((text, i) => (
                  <li
                    key={text}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    className={styles.suggestOption}
                    // mousedown (không phải click) + preventDefault: giữ focus ở ô nhập, tránh blur đóng danh sách trước khi chọn
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(i);
                    }}
                  >
                    {text}
                  </li>
                ))
              : null}
          </ul>
        </div>
        <Button type="submit" size="lg">
          Tìm
        </Button>
      </div>
      <div role="status" aria-live="polite" className="visually-hidden">
        {open ? `${items.length} gợi ý. Dùng phím mũi tên lên xuống để chọn, Enter để tìm, Esc để đóng.` : ""}
      </div>
    </form>
  );
}
