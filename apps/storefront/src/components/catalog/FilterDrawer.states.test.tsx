// UX-STATE-001: 4 trạng thái của FilterDrawer (đếm kết quả nháp). Đếm chỉ là phụ: loading/error → nhãn trung tính
// "Xem kết quả", nút vẫn áp dụng được; empty → "Xem 0 sản phẩm"; success → "Xem N sản phẩm".
import { fireEvent, render, screen } from "@testing-library/react";
import { parseFilter } from "@x-shop/domain";
import { FilterDrawer } from "./FilterDrawer";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/danh-muc/ao" }));

const facets = {
  color: [{ value: "den", label: "Đen", count: 5 }],
  size: [{ value: "m", label: "M", count: 4 }],
  material: [],
};
const applied = parseFilter(new URLSearchParams("color=den")).filter;

function openAndEdit() {
  render(
    <FilterDrawer basePath="/danh-muc/ao" applied={applied} facets={facets} total={5} activeCount={1} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Bộ lọc (1)" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
}

afterEach(() => {
  push.mockReset();
  vi.unstubAllGlobals();
});

describe("FilterDrawer — 4 trạng thái đếm kết quả", () => {
  it("loading: đang đếm → nhãn trung tính 'Xem kết quả', nút vẫn bấm được", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    openAndEdit();
    expect(screen.getByRole("button", { name: "Xem kết quả" })).toBeEnabled();
  });

  it("empty: bộ lọc nháp không có sản phẩm → 'Xem 0 sản phẩm'", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ total: 0 }));
    openAndEdit();
    expect(await screen.findByRole("button", { name: "Xem 0 sản phẩm" })).toBeInTheDocument();
  });

  it("error: API đếm lỗi (422, không thử lại) → giữ nhãn trung tính, vẫn áp dụng được", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 422 }));
    openAndEdit();
    await new Promise((r) => setTimeout(r, 400));
    fireEvent.click(screen.getByRole("button", { name: "Xem kết quả" }));
    expect(push).toHaveBeenCalledWith("/danh-muc/ao?color=den&size=m");
  });

  it("success: có số → 'Xem N sản phẩm'", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ total: 3 }));
    openAndEdit();
    expect(await screen.findByRole("button", { name: "Xem 3 sản phẩm" })).toBeInTheDocument();
  });
});
