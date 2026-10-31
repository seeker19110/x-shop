// UX-STATE-001: 4 trạng thái của CartContents (thao tác dòng giỏ qua Server Action).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CartLineView, CartView } from "../../lib/cart/types";

const actions = vi.hoisted(() => ({
  changeLineVariant: vi.fn(),
  refreshCartLine: vi.fn(),
  removeCartLine: vi.fn(),
  updateLineQuantity: vi.fn(),
}));
vi.mock("../../lib/cart/actions", () => actions);
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- mock next/image trong test, cần thẻ img thuần
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

import { CartContents } from "./CartContents";

beforeEach(() => Object.values(actions).forEach((f) => f.mockReset()));

const line: CartLineView = {
  id: "l1",
  variantId: "v1",
  handle: "ao-so-mi-lua",
  title: "Áo sơ mi lụa",
  variantLabel: "Đen / M",
  thumbnail: null,
  unitPrice: 700000,
  quantity: 2,
  lineTotal: 1400000,
  issue: null,
  choices: null,
};
const cart = (lines: CartLineView[]): CartView => ({
  lines,
  itemCount: lines.reduce((s, l) => s + l.quantity, 0),
  subtotal: lines.reduce((s, l) => s + l.lineTotal, 0),
  blocked: lines.some((l) => l.issue),
});
const inc = () => screen.getByRole("button", { name: "Tăng số lượng Áo sơ mi lụa" });

describe("CartContents — 4 trạng thái", () => {
  it("loading: đang cập nhật dòng → dòng aria-busy, nút số lượng/xóa bị khóa", async () => {
    let done: (r: unknown) => void = () => undefined;
    actions.updateLineQuantity.mockImplementation(() => new Promise((r) => (done = r)));
    render(<CartContents cart={cart([line])} />);
    fireEvent.click(inc());
    await waitFor(() =>
      expect(document.querySelector("[data-line-id=l1]")).toHaveAttribute("aria-busy", "true"),
    );
    expect(inc()).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Xóa/ })).toBeDisabled();
    await act(async () => done({ ok: true, count: 3, message: "Đã cập nhật số lượng." }));
  });

  it("empty: giỏ trống → thông báo tiếng Việt kèm đường đi tiếp, không có nút thanh toán", () => {
    render(<CartContents cart={cart([])} />);
    expect(screen.getByRole("heading", { name: "Giỏ hàng của bạn đang trống" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tiếp tục mua sắm" })).toHaveAttribute("href", "/tim-kiem");
    expect(screen.queryByRole("link", { name: "Thanh toán" })).toBeNull();
  });

  it("error: server từ chối → lỗi hiện ngay tại dòng (role=alert, aria-describedby), dòng dùng lại được", async () => {
    actions.updateLineQuantity.mockResolvedValue({ ok: false, message: "Chỉ còn 2 sản phẩm trong kho." });
    render(<CartContents cart={cart([line])} />);
    fireEvent.click(inc());
    expect(await screen.findByRole("alert")).toHaveTextContent("Chỉ còn 2 sản phẩm trong kho.");
    expect(document.querySelector("[data-line-id=l1]")).toHaveAttribute("aria-describedby", "loi-l1");
    await waitFor(() => expect(inc()).toBeEnabled());
  });

  it("success: cập nhật được → thông báo aria-live và phát số giỏ cho header", async () => {
    const counts: number[] = [];
    const on = (e: Event) => counts.push((e as CustomEvent<{ count: number }>).detail.count);
    window.addEventListener("xs:cart-changed", on);
    actions.updateLineQuantity.mockResolvedValue({ ok: true, count: 3, message: "Đã cập nhật số lượng." });
    render(<CartContents cart={cart([line])} />);
    fireEvent.click(inc());
    await waitFor(() => expect(screen.getByText("Đã cập nhật số lượng.")).toBeInTheDocument());
    expect(counts).toEqual([3]);
    expect(actions.updateLineQuantity).toHaveBeenCalledWith("l1", 3);
    window.removeEventListener("xs:cart-changed", on);
  });
});
