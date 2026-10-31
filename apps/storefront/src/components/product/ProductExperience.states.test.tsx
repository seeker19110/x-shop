// UX-STATE-001: 4 trạng thái của ProductExperience (thêm vào giỏ qua Server Action).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FIXTURE_PRODUCTS } from "../../lib/catalog/fixtures";
import { ProductExperience } from "./ProductExperience";
import { initialSelection } from "./selection";

const addToCartMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/cart/actions", () => ({ addToCart: addToCartMock }));

beforeEach(() => {
  addToCartMock.mockReset();
});

function setup(handle: string, params: Record<string, string> = {}) {
  const p = FIXTURE_PRODUCTS.find((x) => x.handle === handle)!;
  return render(<ProductExperience product={p} initial={initialSelection(p, params)} />);
}
const cta = () => document.querySelector<HTMLButtonElement>("button[data-cta]")!;

describe("ProductExperience — 4 trạng thái", () => {
  it("loading: đang thêm vào giỏ → nút aria-busy, bấm lại không gọi thêm lần nữa", async () => {
    addToCartMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, count: 1, message: "Đã thêm vào giỏ." };
    });
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    let busy: string | null | undefined;
    setTimeout(() => {
      busy = cta().getAttribute("aria-busy");
      fireEvent.click(cta());
    }, 20);
    await act(async () => {
      fireEvent.click(cta());
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(busy).toBe("true");
    expect(addToCartMock).toHaveBeenCalledTimes(1);
  });

  it("empty: sản phẩm hết hàng toàn bộ → nút 'Hết hàng' bị khóa, không gọi server", () => {
    setup("quan-tay-ong-dung");
    expect(cta()).toHaveTextContent("Hết hàng");
    expect(cta()).toBeDisabled();
    fireEvent.click(cta());
    expect(addToCartMock).not.toHaveBeenCalled();
  });

  it("error: server từ chối → lỗi role=alert tiếng Việt, không báo 'đã thêm', nút dùng lại được", async () => {
    addToCartMock.mockResolvedValue({
      ok: false,
      code: "OUT_OF_STOCK",
      message: "Phiên bản này đã hết hàng.",
    });
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    fireEvent.click(cta());
    expect(await screen.findByRole("alert")).toHaveTextContent("Phiên bản này đã hết hàng.");
    expect(screen.queryByRole("link", { name: "Xem giỏ hàng" })).toBeNull();
    await waitFor(() => expect(cta()).not.toHaveAttribute("aria-busy"));
  });

  it("success: thêm được → thông báo aria-live và liên kết 'Xem giỏ hàng'", async () => {
    addToCartMock.mockResolvedValue({ ok: true, count: 1, message: "Đã thêm vào giỏ." });
    setup("ao-so-mi-lua", { color: "den", size: "s" });
    fireEvent.click(cta());
    expect(await screen.findByRole("link", { name: "Xem giỏ hàng" })).toHaveAttribute("href", "/gio-hang");
    expect(screen.getByRole("status")).toHaveTextContent("Đã thêm vào giỏ.");
  });
});
