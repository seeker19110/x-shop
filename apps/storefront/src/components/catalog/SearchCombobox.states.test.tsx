// UX-STATE-001: 4 trạng thái của SearchCombobox. Gợi ý chỉ là tiện ích: tìm kiếm thường (form GET) luôn dùng được
// nên loading/error không chặn gì — danh sách đóng, không có UI lỗi.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchCombobox } from "./SearchCombobox";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const input = () => screen.getByRole("combobox");
async function typeAndWait(v: string) {
  fireEvent.change(input(), { target: { value: v } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe("SearchCombobox — 4 trạng thái", () => {
  it("loading: đang chờ gợi ý → danh sách đóng, ô nhập và nút Tìm vẫn dùng được", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    await typeAndWait("áo");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Tìm" })).toBeEnabled();
  });

  it("empty: API không có gợi ý → không mở danh sách, không có lựa chọn", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ suggestions: [] })));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    await typeAndWait("zzz");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("error: mạng lỗi/HTTP 503 → danh sách đóng, không ném, tìm kiếm thường vẫn gửi được", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    await typeAndWait("áo");
    expect(input()).toHaveAttribute("aria-expanded", "false");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    await typeAndWait("áo dài");
    expect(screen.queryByRole("option")).toBeNull();
    expect(input().closest("form")).toHaveAttribute("action", "/tim-kiem");
  });

  it("success: có gợi ý → mở listbox, báo số gợi ý cho trình đọc màn hình", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ suggestions: ["Áo sơ mi", "Áo dài"] })));
    render(<SearchCombobox defaultValue={null} maxLength={100} />);
    await typeAndWait("áo");
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("2 gợi ý");
  });
});
