import { act, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { SearchCombobox } from "./SearchCombobox";
import { moveActive, normalizeTyped, sanitizeSuggestions, shouldSuggest } from "./search-suggest";

describe("search-suggest: hàm thuần", () => {
  it("normalizeTyped: NFC, gọn khoảng trắng, cắt đúng 100 ký tự (không cắt đôi ký tự Unicode)", () => {
    expect(normalizeTyped("  áo   sơ  mi ", 100)).toBe("áo sơ mi");
    // "á" dạng tổ hợp (a + U+0301) được chuẩn hóa về 1 ký tự
    expect(normalizeTyped("áo", 100)).toBe("áo");
    const long = "a".repeat(150);
    expect([...normalizeTyped(long, 100)]).toHaveLength(100);
    const emoji = "😀".repeat(120);
    expect([...normalizeTyped(emoji, 100)]).toHaveLength(100);
    expect(normalizeTyped("   ", 100)).toBe("");
  });

  it("shouldSuggest: cần ≥ 2 ký tự (tính theo ký tự, không theo byte)", () => {
    expect(shouldSuggest("")).toBe(false);
    expect(shouldSuggest("a")).toBe(false);
    expect(shouldSuggest("ao")).toBe(true);
    expect(shouldSuggest("đ")).toBe(false);
    expect(shouldSuggest("áo")).toBe(true);
  });

  it("sanitizeSuggestions: chỉ chuỗi, bỏ rỗng/trùng, tối đa 8", () => {
    expect(sanitizeSuggestions(null)).toEqual([]);
    expect(sanitizeSuggestions({ suggestions: "x" })).toEqual([]);
    expect(sanitizeSuggestions({ suggestions: ["a", "a", " ", 3, null, "b "] })).toEqual(["a", "b"]);
    const many = { suggestions: Array.from({ length: 20 }, (_, i) => `s${i}`) };
    expect(sanitizeSuggestions(many)).toHaveLength(8);
  });

  it("moveActive: quay vòng, -1 là ô nhập, rỗng → -1", () => {
    expect(moveActive(-1, "ArrowDown", 3)).toBe(0);
    expect(moveActive(2, "ArrowDown", 3)).toBe(0);
    expect(moveActive(-1, "ArrowUp", 3)).toBe(2);
    expect(moveActive(0, "ArrowUp", 3)).toBe(2);
    expect(moveActive(1, "ArrowUp", 3)).toBe(0);
    expect(moveActive(0, "ArrowDown", 0)).toBe(-1);
  });
});

/* ------------------------------------------------------------------ component */

const suggestions = (n: number) => Array.from({ length: n }, (_, i) => `Áo sơ mi ${i + 1}`);

function mockFetch(list: string[] | (() => Promise<Response>)) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) =>
    typeof list === "function" ? list() : new Response(JSON.stringify({ suggestions: list })),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const input = () => screen.getByRole("combobox");
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
const flush = async (ms = 250) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SearchCombobox: debounce, giới hạn", () => {
  it("gõ liên tiếp chỉ gọi API MỘT lần sau 250 ms, với truy vấn cuối đã mã hóa URL", async () => {
    const f = mockFetch(suggestions(3));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("áo");
    await flush(100);
    type("áo s");
    await flush(100);
    type("áo sơ");
    await flush(249);
    expect(f).not.toHaveBeenCalled();
    await flush(1);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(`/api/catalog/suggest?q=${encodeURIComponent("áo sơ")}`);
  });

  it("dưới 2 ký tự: không gọi API và đóng danh sách đang mở", async () => {
    const f = mockFetch(suggestions(3));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("ao");
    await flush();
    expect(input()).toHaveAttribute("aria-expanded", "true");
    type("a");
    await flush();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("truy vấn gửi đi ≤ 100 ký tự và ô nhập có maxLength=100", async () => {
    const f = mockFetch(suggestions(1));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    expect(input()).toHaveAttribute("maxlength", "100");
    type("b".repeat(130));
    await flush();
    const q = decodeURIComponent(String(f.mock.calls[0]![0]).split("q=")[1]!);
    expect([...q]).toHaveLength(100);
  });

  it("hiện tối đa 8 gợi ý dù server trả nhiều hơn", async () => {
    mockFetch(suggestions(15));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("áo");
    await flush();
    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  it("phản hồi cũ đến muộn không ghi đè kết quả mới (bị hủy bằng AbortController)", async () => {
    let first: ((r: Response) => void) | undefined;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes(encodeURIComponent("áo a"))) {
        return new Promise<Response>((resolve, reject) => {
          first = resolve;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(JSON.stringify({ suggestions: ["Kết quả mới"] }));
    });
    vi.stubGlobal("fetch", f);
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("áo a");
    await flush();
    type("áo b");
    await flush();
    first?.(new Response(JSON.stringify({ suggestions: ["Kết quả cũ"] })));
    await flush(0);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Kết quả mới"]);
  });

  it("lỗi mạng hoặc 503: danh sách đóng, không ném, form vẫn dùng được", async () => {
    mockFetch(async () => {
      throw new TypeError("offline");
    });
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("áo");
    await flush();
    expect(input()).toHaveAttribute("aria-expanded", "false");
    mockFetch(async () => new Response("{}", { status: 503 }));
    type("áo dài");
    await flush();
    expect(screen.queryByRole("option")).toBeNull();
  });
});

describe("SearchCombobox: ARIA và bàn phím", () => {
  async function open(n = 3) {
    mockFetch(suggestions(n));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    input().focus();
    type("áo");
    await flush();
  }

  it("mẫu combobox: role, aria-expanded/controls/autocomplete, listbox có nhãn, option có id", async () => {
    mockFetch(suggestions(3));
    render(<SearchCombobox defaultValue="" maxLength={100} />);
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).toHaveAttribute("aria-autocomplete", "list");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    type("áo");
    await flush();
    const list = screen.getByRole("listbox", { name: "Gợi ý tìm kiếm" });
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    const ids = screen.getAllByRole("option").map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    expect(screen.getByRole("status")).toHaveTextContent("3 gợi ý");
  });

  it("ArrowDown/ArrowUp đổi aria-activedescendant + aria-selected, quay vòng; focus ở lại ô nhập", async () => {
    await open(3);
    const opts = () => screen.getAllByRole("option");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input()).toHaveAttribute("aria-activedescendant", opts()[0]!.id);
    expect(opts()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // quay về 0
    expect(opts()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input(), { key: "ArrowUp" }); // quay xuống cuối
    expect(input()).toHaveAttribute("aria-activedescendant", opts()[2]!.id);
    expect(document.activeElement).toBe(input());
  });

  it("Enter khi đang chọn một gợi ý: điền gợi ý và gửi form; không chọn gì: để form gửi bình thường", async () => {
    await open(3);
    const form = input().closest("form")!;
    const submit = vi.fn();
    form.requestSubmit = submit;
    fireEvent.keyDown(input(), { key: "Enter" }); // chưa chọn gợi ý
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect((input() as HTMLInputElement).value).toBe("Áo sơ mi 2");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("Esc đóng danh sách và bỏ chọn; khi đã đóng không chặn phím", async () => {
    await open(3);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(true); // không preventDefault
  });

  it("click (mousedown) vào gợi ý chọn và gửi form; blur đóng danh sách", async () => {
    await open(3);
    const form = input().closest("form")!;
    const submit = vi.fn();
    form.requestSubmit = submit;
    fireEvent.mouseDown(screen.getAllByRole("option")[1]!);
    expect((input() as HTMLInputElement).value).toBe("Áo sơ mi 2");
    expect(submit).toHaveBeenCalledTimes(1);
    type("áo");
    await flush();
    expect(input()).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(input());
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("form vẫn là GET /tim-kiem?q= (chạy không cần JS) và có nhãn thật", () => {
    render(<SearchCombobox defaultValue="áo" maxLength={100} />);
    const form = input().closest("form")!;
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/tim-kiem");
    expect(input()).toHaveAttribute("name", "q");
    expect(screen.getByLabelText("Tìm theo tên, mã SKU hoặc danh mục")).toBe(input());
    expect((input() as HTMLInputElement).value).toBe("áo");
  });

  it("axe: không lỗi serious/critical khi danh sách mở", async () => {
    vi.useRealTimers();
    mockFetch(suggestions(3));
    const { container } = render(<SearchCombobox defaultValue={null} maxLength={100} />);
    type("áo");
    await new Promise((r) => setTimeout(r, 300));
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
