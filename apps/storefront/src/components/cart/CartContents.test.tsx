import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { CartLineView, CartView } from "../../lib/cart/types";
import { CartContents } from "./CartContents";

const actions = vi.hoisted(() => ({
  changeLineVariant: vi.fn(),
  refreshCartLine: vi.fn(),
  removeCartLine: vi.fn(),
  updateLineQuantity: vi.fn(),
}));
vi.mock("../../lib/cart/actions", () => actions);
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const choices = {
  colors: [
    { value: "den", label: "Đen" },
    { value: "trang", label: "Trắng" },
  ],
  sizes: [
    { value: "s", label: "S" },
    { value: "m", label: "M" },
  ],
  variants: [
    { id: "v_den_m", color: "den", size: "m", inStock: true },
    { id: "v_den_s", color: "den", size: "s", inStock: false },
    { id: "v_trang_s", color: "trang", size: "s", inStock: true },
  ],
};

const line = (over: Partial<CartLineView> & { id: string }): CartLineView => ({
  variantId: "v_den_m",
  handle: "ao-so-mi-lua",
  title: "Áo sơ mi lụa",
  variantLabel: "Đen / M",
  thumbnail: null,
  unitPrice: 700000,
  quantity: 2,
  lineTotal: 1400000,
  issue: null,
  choices: { ...choices, color: "den", size: "m" },
  ...over,
});

const cart = (lines: CartLineView[], over: Partial<CartView> = {}): CartView => ({
  id: "cart_1",
  lines,
  itemCount: lines.reduce((s, l) => s + l.quantity, 0),
  subtotal: lines.reduce((s, l) => s + l.lineTotal, 0),
  blocked: lines.some((l) => l.issue),
  ...over,
});

const ok = (count = 1, message = "Đã cập nhật số lượng.") => ({ ok: true as const, count, message });

beforeEach(() => {
  for (const f of Object.values(actions)) f.mockReset();
});

describe("giỏ hàng: hiển thị", () => {
  it("giỏ rỗng → trạng thái rỗng có đường đi tiếp, không có nút thanh toán", () => {
    render(<CartContents cart={cart([])} />);
    expect(screen.getByRole("heading", { name: "Giỏ hàng của bạn đang trống" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tiếp tục mua sắm" })).toHaveAttribute("href", "/tim-kiem");
    expect(screen.queryByRole("link", { name: "Thanh toán" })).toBeNull();
  });

  it("tạm tính là số server trả (không cộng lại ở client) và nút Thanh toán là liên kết tới /thanh-toan", () => {
    // Cố ý đặt subtotal KHÁC tổng các dòng để chứng minh client không tự tính.
    render(<CartContents cart={cart([line({ id: "l1" })], { subtotal: 1234000 })} />);
    expect(screen.getByText("Tạm tính").nextElementSibling).toHaveTextContent("1.234.000 ₫");
    expect(screen.getByRole("link", { name: "Thanh toán" })).toHaveAttribute("href", "/thanh-toan");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Giỏ hàng (2)");
  });
});

describe("CHK01: lỗi từng dòng", () => {
  const issueCart = cart([
    line({
      id: "l1",
      issue: { code: "OUT_OF_STOCK", message: "Phiên bản này đã hết hàng." },
      variantId: "v_den_s",
    }),
    line({ id: "l2", title: "Quần tây", unitPrice: 300000, lineTotal: 300000, quantity: 1 }),
    line({
      id: "l3",
      title: "Váy",
      issue: { code: "PRICE_CHANGED", message: "Giá đã thay đổi từ 650.000 ₫ thành 700.000 ₫." },
    }),
  ]);

  it("lỗi hiện tại ĐÚNG dòng, dòng khác còn nguyên, thanh toán bị chặn có giải thích", () => {
    render(<CartContents cart={issueCart} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("Phiên bản này đã hết hàng.")).toBeInTheDocument();
    expect(within(items[1]!).queryByText(/Phiên bản này đã hết hàng|Giá đã thay đổi/)).toBeNull();
    expect(within(items[2]!).getByText(/Giá đã thay đổi/)).toBeInTheDocument();
    // dòng gắn lỗi qua aria-describedby
    expect(items[0]).toHaveAttribute("aria-describedby", expect.stringContaining("loi-l1-van-de"));
    const pay = screen.getByRole("button", { name: "Thanh toán" });
    expect(pay).toBeDisabled();
    expect(pay).toHaveAttribute("aria-describedby", "chan-thanh-toan");
    expect(document.getElementById("chan-thanh-toan")).toHaveTextContent("Có 2 sản phẩm cần xử lý");
    expect(screen.queryByRole("link", { name: "Thanh toán" })).toBeNull();
  });

  it("dòng lỗi vẫn xóa được; dòng giá đổi có nút 'Cập nhật giá'", async () => {
    actions.removeCartLine.mockResolvedValue(ok(3, "Đã xóa sản phẩm khỏi giỏ."));
    actions.refreshCartLine.mockResolvedValue(ok(2, "Đã cập nhật giá."));
    render(<CartContents cart={issueCart} />);
    const items = screen.getAllByRole("listitem");
    fireEvent.click(within(items[0]!).getByRole("button", { name: /^Xóa/ }));
    await waitFor(() => expect(actions.removeCartLine).toHaveBeenCalledWith("l1"));
    expect(within(items[0]!).queryByRole("button", { name: "Cập nhật giá" })).toBeNull();
    fireEvent.click(within(items[2]!).getByRole("button", { name: "Cập nhật giá" }));
    await waitFor(() => expect(actions.refreshCartLine).toHaveBeenCalledWith("l3"));
  });

  it("thao tác của server bị từ chối → lỗi hiện tại dòng đó (role=alert), dòng khác không bị đụng", async () => {
    actions.updateLineQuantity.mockResolvedValue({
      ok: false,
      code: "OUT_OF_STOCK",
      message: "Số lượng yêu cầu vượt quá tồn kho hiện có.",
    });
    render(<CartContents cart={cart([line({ id: "l1" }), line({ id: "l2", title: "Quần tây" })])} />);
    const [a, b] = screen.getAllByRole("listitem");
    fireEvent.click(within(a!).getByRole("button", { name: /^Tăng số lượng/ }));
    expect(await within(a!).findByRole("alert")).toHaveTextContent("vượt quá tồn kho");
    expect(within(b!).queryByRole("alert")).toBeNull();
  });
});

describe("thao tác", () => {
  it("tăng/giảm số lượng gọi server action với số lượng mới; giảm bị khóa ở 1, tăng khóa ở 99", async () => {
    actions.updateLineQuantity.mockResolvedValue(ok(3));
    const events: number[] = [];
    const on = (e: Event) => events.push((e as CustomEvent<{ count: number }>).detail.count);
    window.addEventListener("xs:cart-changed", on);
    render(<CartContents cart={cart([line({ id: "l1", quantity: 2 })])} />);
    fireEvent.click(screen.getByRole("button", { name: /^Tăng số lượng/ }));
    await waitFor(() => expect(actions.updateLineQuantity).toHaveBeenCalledWith("l1", 3));
    await waitFor(() => expect(events).toEqual([3]));
    fireEvent.click(screen.getByRole("button", { name: /^Giảm số lượng/ }));
    await waitFor(() => expect(actions.updateLineQuantity).toHaveBeenLastCalledWith("l1", 1));
    window.removeEventListener("xs:cart-changed", on);
  });

  it("biên số lượng: 1 khóa nút giảm, 99 khóa nút tăng", () => {
    const { unmount } = render(<CartContents cart={cart([line({ id: "l1", quantity: 1 })])} />);
    expect(screen.getByRole("button", { name: /^Giảm số lượng/ })).toBeDisabled();
    unmount();
    render(<CartContents cart={cart([line({ id: "l1", quantity: 99 })])} />);
    expect(screen.getByRole("button", { name: /^Tăng số lượng/ })).toBeDisabled();
  });

  it("xóa dòng thành công: thông báo aria-live và đưa focus về tiêu đề (không mất focus)", async () => {
    actions.removeCartLine.mockResolvedValue(ok(0, "Đã xóa sản phẩm khỏi giỏ."));
    render(<CartContents cart={cart([line({ id: "l1" })])} />);
    fireEvent.click(screen.getByRole("button", { name: /^Xóa/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Đã xóa sản phẩm khỏi giỏ."));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("đổi size sang biến thể có sẵn gọi changeLineVariant với biến thể đích", async () => {
    actions.changeLineVariant.mockResolvedValue(ok(2, "Đã đổi."));
    render(
      <CartContents cart={cart([line({ id: "l1", choices: { ...choices, color: "den", size: "m" } })])} />,
    );
    const sizeSelect = screen.getByLabelText("Size");
    // Size S của màu đen hết hàng: tùy chọn bị khóa (trừ khi đang chọn); chỉ M khả dụng → thử đổi màu.
    expect(within(sizeSelect).getByRole("option", { name: "S (hết hàng)" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Màu"), { target: { value: "trang" } });
    // (trắng, m) không tồn tại → báo tại dòng, KHÔNG gọi server
    expect(await screen.findByRole("alert")).toHaveTextContent("Màu Trắng không có size M");
    expect(actions.changeLineVariant).not.toHaveBeenCalled();
  });

  it("đổi màu khi size tương ứng tồn tại → gọi server", async () => {
    actions.changeLineVariant.mockResolvedValue(ok(2, "Đã đổi."));
    render(
      <CartContents
        cart={cart([
          line({ id: "l1", variantId: "v_den_s", choices: { ...choices, color: "den", size: "s" } }),
        ])}
      />,
    );
    fireEvent.change(screen.getByLabelText("Màu"), { target: { value: "trang" } });
    await waitFor(() => expect(actions.changeLineVariant).toHaveBeenCalledWith("l1", "v_trang_s"));
  });

  it("dòng không có dữ liệu catalog (choices=null): không có bộ chọn, vẫn sửa số lượng/xóa được", () => {
    render(<CartContents cart={cart([line({ id: "l1", choices: null })])} />);
    expect(screen.queryByLabelText("Màu")).toBeNull();
    expect(screen.getByRole("button", { name: /^Xóa/ })).toBeEnabled();
  });
});

describe("S-509: axe", () => {
  it("giỏ có lỗi dòng và giỏ rỗng không có lỗi serious/critical", async () => {
    const run = async (c: CartView) => {
      const { container, unmount } = render(<main>{<CartContents cart={c} />}</main>);
      const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
      unmount();
      return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
    };
    await act(async () => undefined);
    expect(
      await run(
        cart([
          line({ id: "l1", issue: { code: "OUT_OF_STOCK", message: "Phiên bản này đã hết hàng." } }),
          line({ id: "l2", thumbnail: { url: "/a.jpg", alt: "Quần tây" } }),
        ]),
      ),
    ).toEqual([]);
    expect(await run(cart([]))).toEqual([]);
  });
});
