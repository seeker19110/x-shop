import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { isTextEntry, shouldShowSticky } from "./sticky";
import { StickyCta } from "./StickyCta";

type IoCallback = (entries: Array<Pick<IntersectionObserverEntry, "isIntersecting">>) => void;
let ioCallbacks: IoCallback[] = [];

class FakeObserver {
  constructor(cb: IoCallback) {
    ioCallbacks.push(cb);
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

const emit = (isIntersecting: boolean) =>
  act(() => {
    for (const cb of ioCallbacks) cb([{ isIntersecting }]);
  });

function Harness({ disabled = false }: { disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref}>khối mua chính</div>
      <input aria-label="ô nhập" />
      <input type="checkbox" aria-label="hộp tích" />
      <StickyCta
        target={ref}
        label="Chọn size"
        priceLabel="700.000 ₫"
        disabled={disabled}
        loading={false}
        onClick={() => {}}
      />
    </>
  );
}

beforeEach(() => {
  ioCallbacks = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe("shouldShowSticky (product)", () => {
  it("chỉ hiện khi khối mua RA KHỎI viewport và không có ô nhập focus", () => {
    expect(shouldShowSticky({ buyBoxInView: true, textEntryFocused: false })).toBe(false);
    expect(shouldShowSticky({ buyBoxInView: false, textEntryFocused: false })).toBe(true);
    expect(shouldShowSticky({ buyBoxInView: false, textEntryFocused: true })).toBe(false);
  });
  it("chưa biết (null: SSR/chưa quan sát) → không hiện", () => {
    expect(shouldShowSticky({ buyBoxInView: null, textEntryFocused: false })).toBe(false);
  });
});

describe("isTextEntry (product)", () => {
  const make = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild;
  };
  it("input chữ/số, textarea, select, contenteditable là ô nhập", () => {
    expect(isTextEntry(make("<input>"))).toBe(true);
    expect(isTextEntry(make('<input type="tel">'))).toBe(true);
    expect(isTextEntry(make('<input type="search">'))).toBe(true);
    expect(isTextEntry(make("<textarea></textarea>"))).toBe(true);
    expect(isTextEntry(make("<select></select>"))).toBe(true);
  });
  it("checkbox/radio/nút/null/phần tử khác thì không", () => {
    expect(isTextEntry(make('<input type="checkbox">'))).toBe(false);
    expect(isTextEntry(make('<input type="radio">'))).toBe(false);
    expect(isTextEntry(make('<input type="submit">'))).toBe(false);
    expect(isTextEntry(make("<button></button>"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});

describe("StickyCta (product)", () => {
  it("mặc định chưa hiện; khối mua ra khỏi viewport → hiện (có vùng 'Mua nhanh', giá, CTA); vào lại → ẩn", () => {
    render(<Harness />);
    expect(screen.queryByRole("region", { name: "Mua nhanh" })).toBeNull();
    emit(false);
    const region = screen.getByRole("region", { name: "Mua nhanh" });
    expect(region).toHaveTextContent("700.000 ₫");
    expect(screen.getByRole("button", { name: "Chọn size" })).toBeInTheDocument();
    emit(true);
    expect(screen.queryByRole("region", { name: "Mua nhanh" })).toBeNull();
  });

  it("ẩn khi ô nhập có focus, hiện lại khi rời focus; checkbox không làm ẩn", () => {
    render(<Harness />);
    emit(false);
    const input = screen.getByLabelText("ô nhập");
    act(() => input.focus());
    expect(screen.queryByRole("region", { name: "Mua nhanh" })).toBeNull();
    act(() => input.blur());
    expect(screen.getByRole("region", { name: "Mua nhanh" })).toBeInTheDocument();
    act(() => screen.getByLabelText("hộp tích").focus());
    expect(screen.getByRole("region", { name: "Mua nhanh" })).toBeInTheDocument();
  });

  it("nút phản ánh trạng thái disabled của CTA chính", () => {
    render(<Harness disabled />);
    emit(false);
    expect(screen.getByRole("button", { name: "Chọn size" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Chọn size" }));
  });

  it("trình duyệt không có IntersectionObserver → không hiện, không ném lỗi", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    expect(() => render(<Harness />)).not.toThrow();
    expect(screen.queryByRole("region", { name: "Mua nhanh" })).toBeNull();
  });
});
