import { parseFilter } from "@x-shop/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Facets } from "../../lib/catalog/types";
import { FilterDrawer } from "./FilterDrawer";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/danh-muc/ao" }));

const FACETS: Facets = {
  color: [
    { value: "den", label: "Đen", count: 5 },
    { value: "trang", label: "Trắng", count: 3 },
  ],
  size: [
    { value: "m", label: "M", count: 4 },
    { value: "l", label: "L", count: 2 },
  ],
  material: [{ value: "cotton", label: "Cotton", count: 4 }],
};

const applied = parseFilter(new URLSearchParams("color=den")).filter;

function setup(total = 5) {
  render(
    <FilterDrawer
      basePath="/danh-muc/ao"
      applied={applied}
      facets={FACETS}
      total={total}
      activeCount={1}
      category="ao"
    />,
  );
  return screen.getByRole("button", { name: "Bộ lọc (1)" });
}

const openDrawer = (btn: HTMLElement) => fireEvent.click(btn);
const dialog = () => screen.getByRole("dialog", { name: "Bộ lọc" });

afterEach(() => {
  push.mockReset();
  vi.unstubAllGlobals();
});

describe("FilterDrawer (catalog) — nháp chỉ áp khi xác nhận", () => {
  it("nút hiện số điều kiện đang áp; mở ra có trường theo facet, lựa chọn đã chốt được tích sẵn", () => {
    const btn = setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    openDrawer(btn);
    expect(screen.getByRole("checkbox", { name: /Đen/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Trắng/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Xem 5 sản phẩm" })).toBeInTheDocument();
  });

  it("AT32: chọn thêm size M (nháp) rồi hủy bằng Esc → KHÔNG đổi URL; mở lại thì nháp đã bị bỏ", () => {
    const btn = setup();
    openDrawer(btn);
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    expect(screen.getByRole("checkbox", { name: /^M/ })).toBeChecked();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(btn).toHaveFocus();
    openDrawer(btn);
    expect(screen.getByRole("checkbox", { name: /^M/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Đen/ })).toBeChecked();
  });

  it("hủy bằng nút đóng (×) cũng không đổi URL", () => {
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /Trắng/ }));
    fireEvent.click(screen.getByRole("button", { name: "Đóng bộ lọc" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("áp dụng → đẩy đúng URL chuẩn (thứ tự ổn định, về trang 1) và đóng drawer", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ total: 2 }));
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /Trắng/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Xem 2 sản phẩm" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/danh-muc/ao?color=den%2Ctrang&size=m");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("N lấy từ API đếm với đúng nháp + phạm vi danh mục; chưa có số → nhãn trung tính", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      void url;
      return Response.json({ total: 3 });
    });
    vi.stubGlobal("fetch", fetchMock);
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /^L/ }));
    expect(screen.getByRole("button", { name: "Xem kết quả" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Xem 3 sản phẩm" })).toBeInTheDocument();
    const url = new URL(fetchMock.mock.calls[0]![0], "http://x");
    expect(url.pathname).toBe("/api/catalog/count");
    expect(url.searchParams.get("color")).toBe("den");
    expect(url.searchParams.get("size")).toBe("l");
    expect(url.searchParams.get("category")).toBe("ao");
  });

  it("nháp trở về đúng bộ lọc đã chốt → dùng lại số có sẵn, không gọi API", async () => {
    const fetchMock = vi.fn(async () => Response.json({ total: 99 }));
    vi.stubGlobal("fetch", fetchMock);
    openDrawer(setup(5));
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    expect(screen.getByRole("button", { name: "Xem 5 sản phẩm" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("API đếm lỗi → vẫn áp dụng được (nhãn trung tính, không ném)", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    await new Promise((r) => setTimeout(r, 400));
    const apply = screen.getByRole("button", { name: "Xem kết quả" });
    fireEvent.click(apply);
    expect(push).toHaveBeenCalledWith("/danh-muc/ao?color=den&size=m");
  });

  it("FE-STATE-005: API đếm lỗi tạm thời (503) rồi ổn → vẫn hiện số, GET được thử lại", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      n++ === 0 ? new Response("{}", { status: 503 }) : Response.json({ total: 4 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    expect(
      await screen.findByRole("button", { name: "Xem 4 sản phẩm" }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("FE-STATE-005: API đếm trả 422 (tham số sai) → KHÔNG thử lại, đúng 1 request", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    openDrawer(setup());
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Xem kết quả" })).toBeInTheDocument();
  });

  it("giá nháp: nhập khoảng giá vào URL; để trống một đầu thì bỏ đầu đó", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ total: 1 }));
    openDrawer(setup());
    fireEvent.change(screen.getByLabelText("Đến"), { target: { value: "500000" } });
    fireEvent.click(await screen.findByRole("button", { name: "Xem 1 sản phẩm" }));
    expect(push).toHaveBeenCalledWith("/danh-muc/ao?color=den&price_max=500000");
  });

  it("'Xóa lựa chọn' bỏ mọi điều kiện trong NHÁP nhưng chưa đổi URL", () => {
    openDrawer(setup());
    fireEvent.click(screen.getByRole("button", { name: "Xóa lựa chọn trong bộ lọc" }));
    expect(screen.getByRole("checkbox", { name: /Đen/ })).not.toBeChecked();
    expect(push).not.toHaveBeenCalled();
  });

  it("còn hàng: checkbox có nhãn; nhập giá không hợp lệ (âm) bị bỏ qua", () => {
    openDrawer(setup());
    expect(screen.getByRole("checkbox", { name: "Chỉ hiện còn hàng" })).not.toBeChecked();
    const from = screen.getByLabelText("Từ") as HTMLInputElement;
    fireEvent.change(from, { target: { value: "-5" } });
    expect(from.value).toBe("");
  });
});
