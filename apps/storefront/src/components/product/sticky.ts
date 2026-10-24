import { useEffect, useState, type RefObject } from "react";

/** Phần tử nhận chữ (bàn phím ảo có thể bật): sticky CTA phải nhường chỗ (S-503). Checkbox/radio/nút không tính. */
export function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"].includes(
      el.type,
    );
  }
  return false;
}

/** Quy tắc hiển thị thuần: chỉ hiện khi khối mua chính RA KHỎI viewport và không có ô nhập đang focus. */
export function shouldShowSticky(state: {
  buyBoxInView: boolean | null;
  textEntryFocused: boolean;
}): boolean {
  return state.buyBoxInView === false && !state.textEntryFocused;
}

/**
 * Theo dõi khối mua chính bằng IntersectionObserver và focus ô nhập. Chưa biết (SSR, chưa quan sát được, trình duyệt
 * không có IO) → không hiện: mặc định an toàn là không che nội dung.
 */
export function useStickyVisible(target: RefObject<Element | null>): boolean {
  const [buyBoxInView, setInView] = useState<boolean | null>(null);
  const [textEntryFocused, setTyping] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);

  useEffect(() => {
    const onIn = (e: FocusEvent) => setTyping(isTextEntry(e.target));
    const onOut = () => setTyping(false);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  return shouldShowSticky({ buyBoxInView, textEntryFocused });
}
