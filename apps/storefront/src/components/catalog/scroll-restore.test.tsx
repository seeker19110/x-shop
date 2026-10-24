import { render } from "@testing-library/react";
import { ScrollRestorer } from "./ScrollRestorer";
import {
  SCROLL_MAX_ENTRIES,
  SCROLL_STORAGE_KEY,
  loadScroll,
  saveScroll,
  scrollKeyOf,
} from "./scroll-restore";

class MemStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe("scroll-restore: lưu/đọc scrollY theo URL", () => {
  it("khóa = đường dẫn + query (không hash)", () => {
    expect(scrollKeyOf({ pathname: "/danh-muc/ao", search: "?color=den&page=2" })).toBe(
      "/danh-muc/ao?color=den&page=2",
    );
  });

  it("lưu rồi đọc lại; URL khác nhau độc lập; làm tròn số nguyên", () => {
    const s = new MemStore();
    saveScroll(s, "/a?p=1", 1234.6);
    saveScroll(s, "/b", 50);
    expect(loadScroll(s, "/a?p=1")).toBe(1235);
    expect(loadScroll(s, "/b")).toBe(50);
    expect(loadScroll(s, "/chua-luu")).toBeNull();
  });

  it("chỉ lưu SỐ theo URL — không có dữ liệu nào khác (không PII)", () => {
    const s = new MemStore();
    saveScroll(s, "/tim-kiem?q=ao", 300);
    const stored = JSON.parse(s.data.get(SCROLL_STORAGE_KEY)!) as Record<string, unknown>;
    expect(Object.values(stored).every((v) => typeof v === "number")).toBe(true);
    expect([...s.data.keys()]).toEqual([SCROLL_STORAGE_KEY]);
  });

  it("biên: 0 hợp lệ; âm/NaN/Infinity bị bỏ qua", () => {
    const s = new MemStore();
    saveScroll(s, "/a", 0);
    expect(loadScroll(s, "/a")).toBe(0);
    saveScroll(s, "/b", -5);
    saveScroll(s, "/c", Number.NaN);
    saveScroll(s, "/d", Number.POSITIVE_INFINITY);
    expect([/b/, /c/, /d/].map((_, i) => loadScroll(s, ["/b", "/c", "/d"][i]!))).toEqual([null, null, null]);
  });

  it("giữ tối đa 20 URL mới nhất", () => {
    const s = new MemStore();
    for (let i = 0; i < SCROLL_MAX_ENTRIES + 5; i++) saveScroll(s, `/u${i}`, i + 1);
    expect(loadScroll(s, "/u0")).toBeNull();
    expect(loadScroll(s, "/u4")).toBeNull();
    expect(loadScroll(s, "/u5")).toBe(6);
    expect(loadScroll(s, `/u${SCROLL_MAX_ENTRIES + 4}`)).toBe(SCROLL_MAX_ENTRIES + 5);
  });

  it("dữ liệu hỏng trong storage (JSON sai, mảng, giá trị không phải số) → bỏ qua, không ném", () => {
    const s = new MemStore();
    s.setItem(SCROLL_STORAGE_KEY, "{không phải json");
    expect(loadScroll(s, "/a")).toBeNull();
    s.setItem(SCROLL_STORAGE_KEY, "[1,2]");
    expect(loadScroll(s, "/a")).toBeNull();
    s.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ "/a": "100", "/b": -1, "/c": 7 }));
    expect(loadScroll(s, "/a")).toBeNull();
    expect(loadScroll(s, "/b")).toBeNull();
    expect(loadScroll(s, "/c")).toBe(7);
  });

  it("storage ném lỗi (đầy/bị chặn) → không ném ra ngoài", () => {
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveScroll(bad, "/a", 10)).not.toThrow();
    expect(loadScroll(bad, "/a")).toBeNull();
  });
});

describe("ScrollRestorer (CAT03)", () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/danh-muc/ao?color=den");
    scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const setY = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true });

  it("cuộn rồi dừng → ghi scrollY theo URL (sau throttle)", () => {
    render(<ScrollRestorer />);
    setY(840);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(130);
    expect(loadScroll(window.sessionStorage, "/danh-muc/ao?color=den")).toBe(840);
  });

  it("bấm liên kết (vào PDP) ghi NGAY vị trí hiện tại, không chờ throttle", () => {
    render(
      <>
        <ScrollRestorer />
        {/* Thẻ <a> thuần là chủ ý: ScrollRestorer nghe click trên mọi liên kết, kể cả ngoài next/link. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/san-pham/x">PDP</a>
      </>,
    );
    setY(1500);
    document.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(loadScroll(window.sessionStorage, "/danh-muc/ao?color=den")).toBe(1500);
  });

  it("Back (popstate) rồi danh sách dựng lại → cuộn về vị trí đã lưu", () => {
    saveScroll(window.sessionStorage, "/danh-muc/ao?color=den", 960);
    window.dispatchEvent(new PopStateEvent("popstate"));
    render(<ScrollRestorer />);
    expect(scrollTo).toHaveBeenCalledWith(0, 960);
  });

  it("vào danh sách bằng liên kết thường (không popstate) → KHÔNG khôi phục dù có giá trị cũ", () => {
    saveScroll(window.sessionStorage, "/danh-muc/ao?color=den", 960);
    render(<ScrollRestorer />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("cờ popstate chỉ dùng một lần: lần dựng kế tiếp không tự khôi phục", () => {
    saveScroll(window.sessionStorage, "/danh-muc/ao?color=den", 960);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const first = render(<ScrollRestorer />);
    first.unmount();
    scrollTo.mockClear();
    render(<ScrollRestorer />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("Back nhưng URL này chưa có vị trí lưu → không cuộn", () => {
    window.dispatchEvent(new PopStateEvent("popstate"));
    render(<ScrollRestorer />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("sessionStorage bị chặn → không ném, không làm gì", () => {
    const spy = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => render(<ScrollRestorer />)).not.toThrow();
    spy.mockRestore();
  });
});
