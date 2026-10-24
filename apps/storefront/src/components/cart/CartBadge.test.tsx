import { act, render, screen, waitFor } from "@testing-library/react";
import { CartBadge } from "./CartBadge";
import { emitCartChanged } from "../../lib/cart/events";

afterEach(() => vi.unstubAllGlobals());

describe("CartBadge (header)", () => {
  it("lấy số từ /api/cart/count (không cache) rồi hiển thị + nhãn cho trình đọc", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ count: 4 })));
    vi.stubGlobal("fetch", fetchMock);
    render(<CartBadge />);
    await waitFor(() => expect(screen.getByText("Giỏ hàng, 4 sản phẩm")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/cart/count", expect.objectContaining({ cache: "no-store" }));
  });

  it("cập nhật ngay khi có sự kiện xs:cart-changed (thêm vào giỏ ở PDP)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ count: 0 })));
    render(<CartBadge />);
    await waitFor(() => expect(screen.getByText("Giỏ hàng, 0 sản phẩm")).toBeInTheDocument());
    act(() => emitCartChanged(7));
    expect(screen.getByText("Giỏ hàng, 7 sản phẩm")).toBeInTheDocument();
  });

  it("lỗi mạng / phản hồi hỏng / số không nguyên → giữ số ban đầu, không ném", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    render(<CartBadge initial={2} />);
    await act(async () => undefined);
    expect(screen.getByText("Giỏ hàng, 2 sản phẩm")).toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent("xs:cart-changed", { detail: { count: 1.5 } })));
    expect(screen.getByText("Giỏ hàng, 2 sản phẩm")).toBeInTheDocument();
  });
});
