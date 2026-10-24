import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PRODUCTS } from "../../lib/catalog/fixtures";
import type { ProductDetail } from "../../lib/catalog/types";
import { ProductExperience } from "./ProductExperience";
import { initialSelection, type Selection } from "./selection";

const product = (handle: string): ProductDetail => FIXTURE_PRODUCTS.find((p) => p.handle === handle)!;

function setup(handle: string, params: Record<string, string> = {}, initial?: Selection) {
  const p = product(handle);
  return render(
    <ProductExperience product={p} initial={initial ?? initialSelection(p, params)}>
      <p>chi tiết (slot)</p>
    </ProductExperience>,
  );
}

const swatch = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const size = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
const cta = () => document.querySelector<HTMLButtonElement>("button[data-cta]")!;
const notice = () => screen.getByRole("status");

let replaceState: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  replaceState = vi.spyOn(window.history, "replaceState");
});
afterEach(() => {
  replaceState.mockRestore();
  vi.unstubAllGlobals();
});

describe("AT02 / S-501: đổi màu khi size không tồn tại (product)", () => {
  it("đen-S đang chọn → bấm Trắng (chỉ có M): bỏ chọn size, aria-live báo đúng câu, CTA 'Chọn size', KHÔNG tự chọn M", () => {
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    expect(size("S")).toHaveAttribute("aria-pressed", "true");
    expect(cta()).toHaveTextContent("Thêm vào giỏ");
    expect(notice()).toHaveAttribute("aria-live", "polite");

    fireEvent.click(swatch("Trắng"));

    expect(notice()).toHaveTextContent("Màu Trắng không có size S — vui lòng chọn lại size");
    expect(size("S")).toHaveAttribute("aria-pressed", "false");
    expect(size("M")).toHaveAttribute("aria-pressed", "false");
    expect(cta()).toHaveTextContent("Chọn size");
    expect(cta()).not.toBeDisabled();
  });

  it("chọn lại size thì thông báo biến mất", () => {
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    fireEvent.click(swatch("Trắng"));
    fireEvent.click(size("M"));
    expect(notice()).toBeEmptyDOMElement();
    expect(cta()).toHaveTextContent("Thêm vào giỏ");
  });

  it("size còn hàng ở màu mới thì giữ nguyên, không thông báo", () => {
    setup("ao-so-mi-oxford", { color: "den", size: "m" });
    fireEvent.click(swatch("Trắng"));
    expect(size("M")).toHaveAttribute("aria-pressed", "true");
    expect(notice()).toBeEmptyDOMElement();
  });
});

describe("nút size & giá theo SKU (product)", () => {
  it("size hết hàng có chữ 'hết hàng', focus được nhưng không chọn được (S-502)", () => {
    setup("ao-so-mi-lua", { color: "den" });
    const m = size("M");
    expect(m).toHaveAttribute("aria-disabled", "true");
    expect(m).toHaveTextContent("hết hàng");
    m.focus();
    expect(m).toHaveFocus();
    fireEvent.click(m);
    expect(m).toHaveAttribute("aria-pressed", "false");
    expect(cta()).toHaveTextContent("Chọn size");
  });

  it("giá đổi theo SKU: đen-M 700.000, trắng-S 300.000; chưa chọn màu → 'Từ 300.000 ₫'", () => {
    const { unmount } = setup("ao-khoac-kaki-mong", {});
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Áo khoác kaki mỏng");
    // màu mặc định = đen, size chưa chọn: giá của màu đen
    expect(document.querySelector("h1 + p")).toHaveTextContent("700.000 ₫");
    fireEvent.click(swatch("Trắng"));
    expect(document.querySelector("h1 + p")).toHaveTextContent("300.000 ₫");
    unmount();
    setup("ao-khoac-kaki-mong", {}, { color: null, size: null });
    expect(document.querySelector("h1 + p")).toHaveTextContent("Từ 300.000 ₫");
    expect(cta()).toHaveTextContent("Chọn màu");
  });

  it("giá giảm: hiện giá gốc cho trình đọc khi chọn đủ SKU", () => {
    setup("ao-thun-cotton-co-tron", { color: "den", size: "m" });
    expect(document.querySelector("h1 + p")).toHaveTextContent("Giá gốc 390.000 ₫, giá hiện tại 290.000 ₫");
  });
});

describe("CTA states (product)", () => {
  it("'Chọn size' bấm được: báo lỗi gắn nhóm size + aria-live, đưa focus về nút size đầu", () => {
    setup("ao-so-mi-oxford", { color: "den" });
    fireEvent.click(cta());
    expect(
      screen.getByText("Vui lòng chọn size trước khi thêm vào giỏ.", { selector: "p[role=status]" }),
    ).toBeInTheDocument();
    expect(size("S")).toHaveFocus();
    // InlineError mô tả nhóm size
    const group = size("S").closest("[role=group]")!;
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("hết hàng: nút 'Hết hàng' bị khóa (cả khi mở thẳng biến thể hết hàng từ URL)", () => {
    setup("ao-so-mi-oxford", { color: "xanh-navy", size: "l" });
    expect(cta()).toHaveTextContent("Hết hàng");
    expect(cta()).toBeDisabled();
  });

  it("sản phẩm hết hàng toàn bộ → 'Hết hàng' ngay khi chưa chọn size", () => {
    setup("quan-tay-ong-dung", {});
    expect(cta()).toHaveTextContent("Hết hàng");
    expect(cta()).toBeDisabled();
  });

  it("'Thêm vào giỏ' gọi server action stub và hiện lỗi rõ 'chưa bật' (T-019 sẽ nối giỏ thật)", async () => {
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    fireEvent.click(cta());
    expect(await screen.findByRole("alert")).toHaveTextContent("Giỏ hàng chưa được bật");
  });
});

describe("URL biến thể (product)", () => {
  it("chọn màu/size cập nhật URL bằng replaceState (không thêm lịch sử), giữ history.state", () => {
    const before = window.history.length;
    setup("ao-so-mi-oxford", { color: "den" });
    expect(replaceState).not.toHaveBeenCalled(); // mở trang không tự ghi URL
    fireEvent.click(swatch("Trắng"));
    expect(replaceState).toHaveBeenLastCalledWith(
      window.history.state,
      "",
      expect.stringMatching(/\?color=trang$/),
    );
    fireEvent.click(size("M"));
    const url = String(replaceState.mock.calls.at(-1)![2]);
    expect(new URLSearchParams(url.split("?")[1]).toString()).toBe("color=trang&size=m");
    expect(window.history.length).toBe(before);
  });

  it("mở bằng ?color=trang&size=m → đúng màu, size, ảnh và CTA", () => {
    setup("ao-so-mi-oxford", { color: "trang", size: "m" });
    expect(swatch("Trắng")).toHaveAttribute("aria-pressed", "true");
    expect(size("M")).toHaveAttribute("aria-pressed", "true");
    expect(cta()).toHaveTextContent("Thêm vào giỏ");
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("alt", expect.stringContaining("màu Trắng"));
  });
});

describe("gallery theo màu + phóng ảnh (product)", () => {
  it("ảnh đổi theo màu; ảnh đầu ưu tiên (không lazy), các ảnh sau lazy", () => {
    setup("ao-so-mi-oxford", { color: "den" });
    const imgs = () => within(screen.getByRole("list", { name: "Ảnh sản phẩm" })).getAllByRole("img");
    expect(imgs()).toHaveLength(3);
    expect(imgs().every((i) => i.getAttribute("alt")!.includes("màu Đen"))).toBe(true);
    expect(imgs()[0]).toHaveAttribute("fetchpriority", "high");
    expect(imgs()[0]).not.toHaveAttribute("loading", "lazy");
    expect(imgs()[1]).toHaveAttribute("loading", "lazy");
    expect(imgs()[2]).toHaveAttribute("loading", "lazy");
    fireEvent.click(swatch("Xanh navy"));
    expect(imgs().every((i) => i.getAttribute("alt")!.includes("màu Xanh navy"))).toBe(true);
    expect(imgs()[0]).toHaveAttribute("width", "1600");
    expect(imgs()[0]).toHaveAttribute("height", "2000");
  });

  it("phóng ảnh trong Dialog: chỉ dựng ảnh lớn khi mở; Esc đóng và trả focus về ảnh", () => {
    setup("ao-so-mi-oxford", { color: "den" });
    const list = () => document.querySelectorAll("img").length;
    const before = list();
    expect(screen.queryByRole("dialog")).toBeNull();
    const opener = screen.getByRole("button", { name: /^Phóng ảnh 2\/3/ });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Phóng ảnh" });
    expect(within(dialog).getByRole("img")).toHaveAttribute("alt", expect.stringContaining("mặt sau"));
    expect(list()).toBe(before + 1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe("bảng size + số đo người mẫu (product)", () => {
  it("nút cạnh selector mở Dialog có bảng (đơn vị cm, đủ cột/hàng, th scope); đóng trả focus", () => {
    setup("ao-so-mi-oxford", { color: "den" });
    const opener = screen.getByRole("button", { name: "Hướng dẫn chọn size" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Bảng size" });
    const table = within(dialog).getByRole("table");
    expect(within(table).getByText("Số đo tính bằng cm")).toBeInTheDocument();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Size", "Ngực", "Dài áo"]);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3);
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["S", "M", "L"]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(opener).toHaveFocus();
  });

  it("số đo người mẫu chỉ hiện với màu có số đo thật (Oxford: trắng có, đen không)", () => {
    setup("ao-so-mi-oxford", { color: "den" });
    expect(screen.queryByText(/Người mẫu/)).toBeNull();
    fireEvent.click(swatch("Trắng"));
    expect(screen.getByText("Người mẫu cao 168 cm, ngực 82 cm, mặc size S.")).toBeInTheDocument();
  });

  it("sản phẩm không có bảng size (túi) → không có nút hướng dẫn", () => {
    setup("tui-tote-vai-canvas", {});
    expect(screen.queryByRole("button", { name: "Hướng dẫn chọn size" })).toBeNull();
  });
});

describe("bố cục & nội dung gần CTA (product)", () => {
  it("tóm tắt giao hàng + đổi trả có liên kết chi tiết; slot chi tiết được dựng", () => {
    setup("ao-so-mi-lua", {});
    const summary = screen.getByRole("list", { name: "Giao hàng và đổi trả" });
    expect(within(summary).getByRole("link", { name: "Chi tiết giao hàng" })).toHaveAttribute(
      "href",
      "/giao-hang",
    );
    expect(within(summary).getByRole("link", { name: "Chi tiết đổi trả" })).toHaveAttribute(
      "href",
      "/doi-tra-hoan-tien",
    );
    expect(screen.getByText("chi tiết (slot)")).toBeInTheDocument();
  });

  it("thứ tự DOM mobile: ảnh → tên/giá → màu/size → CTA → chi tiết", () => {
    setup("ao-so-mi-lua", {});
    const order = [
      screen.getByRole("list", { name: "Ảnh sản phẩm" }),
      screen.getByRole("heading", { level: 1 }),
      screen.getByRole("group", { name: /Màu/ }),
      screen.getByRole("group", { name: /Size/ }),
      cta(),
      screen.getByText("chi tiết (slot)"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("CSS: sticky CTA chừa safe-area, ẩn từ 64em; gallery 6fr/4fr (~60/40) ở desktop", () => {
    const css = readFileSync(join(process.cwd(), "src/components/product/Product.module.css"), "utf8");
    expect(css).toMatch(/\.sticky\s*{[^}]*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/@media \(min-width: 64em\)[\s\S]*grid-template-columns: 6fr 4fr/);
    expect(css).toMatch(/@media \(min-width: 64em\)[\s\S]*\.sticky\s*{\s*display: none/);
  });

  it("sticky CTA xuất hiện khi khối mua ra khỏi viewport và bấm 'Chọn size' đưa người dùng tới nhóm size", async () => {
    let cb: ((e: Array<{ isIntersecting: boolean }>) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(c: typeof cb) {
          cb = c;
        }
        observe() {}
        disconnect() {}
      },
    );
    setup("ao-so-mi-oxford", { color: "den" });
    expect(screen.queryByRole("region", { name: "Mua nhanh" })).toBeNull();
    act(() => cb!([{ isIntersecting: false }]));
    const region = screen.getByRole("region", { name: "Mua nhanh" });
    fireEvent.click(within(region).getByRole("button", { name: "Chọn size" }));
    await waitFor(() => expect(size("S")).toHaveFocus());
    expect(notice()).toHaveTextContent("Vui lòng chọn size");
  });
});
