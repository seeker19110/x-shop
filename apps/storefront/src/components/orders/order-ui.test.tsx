import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { mapOrder } from "../../lib/orders/map";
import type { OrderDetails } from "../../lib/orders/types";

const m = vi.hoisted(() => ({
  refresh: vi.fn(),
  recheck: vi.fn(),
  cancel: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh, push: vi.fn() }) }));
vi.mock("../../lib/orders/actions", () => ({
  recheckOrderAction: m.recheck,
  cancelOrderAction: m.cancel,
  lookupOrderAction: m.lookup,
  redeemLinkAction: vi.fn(),
}));

import { LookupForm } from "./LookupForm";
import { OrderDetail } from "./OrderDetail";

const RAW = {
  display_ref: "XS-ABC123",
  state: "awaiting_payment",
  payment_method: "vnpay",
  payment_state: "pending",
  shipment_state: "unfulfilled",
  created_at: "2026-10-24T10:00:00.000Z",
  hold_expires_at: "2026-10-24T10:15:00.000Z",
  cod_confirm_by: null,
  cancel_reason: null,
  timeline: [{ at: "2026-10-24T10:00:00.000Z", kind: "placed", label: "Đã đặt đơn" }],
  lines: [{ title: "Áo thun", variant_title: "Đen / M", quantity: 1, unit_price: 700000, total: 700000, thumbnail: null }],
  totals: { subtotal: 700000, discount_total: 0, shipping_total: 30000, total: 730000, paid: 0 },
  address: { province_name: "Thành phố Hà Nội", ward_name: "Phường Ba Đình", line: "12 Điện Biên Phủ" },
  contact: { name: "Nguyễn Văn An", phone: "0912***678" },
  actions: { can_cancel: true, can_recheck: true },
};
const order = (patch: Partial<OrderDetails> = {}): OrderDetails => ({ ...mapOrder(RAW)!, ...patch });
const NOW = new Date("2026-10-24T10:05:00Z");

beforeEach(() => {
  m.refresh.mockReset();
  m.recheck.mockReset();
  m.cancel.mockReset();
});

describe("OrderDetail (CHK06): 3 khối riêng, đang xác nhận thanh toán", () => {
  it("ba khối Đặt đơn/Thanh toán/Giao hàng + timeline + mã tham chiếu; không có 'Đã thanh toán'; axe sạch", async () => {
    const { container } = render(<OrderDetail order={order()} now={NOW} />);
    for (const name of ["Đặt đơn", "Thanh toán", "Giao hàng", "Tiến trình", "Cần hỗ trợ?"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    const pay = screen.getByRole("listitem", { name: "Thanh toán" });
    expect(within(pay).getByText("Đang xác nhận thanh toán")).toBeInTheDocument();
    expect(within(pay).getByText(/không cần thanh toán lại/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Đã thanh toán/);
    expect(container.textContent).toContain("XS-ABC123");
    expect(screen.getByRole("button", { name: "Kiểm tra lại" })).toBeInTheDocument();
    // Không có nút/liên kết mời thanh toán lại.
    expect(screen.queryByRole("link", { name: /thanh toán/i })).toBeNull();
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it("Kiểm tra lại: gọi action theo mã đơn rồi dựng lại từ server; mất mạng → báo chưa xác định, không báo paid", async () => {
    m.recheck.mockResolvedValueOnce({ kind: "ok", order: order() });
    render(<OrderDetail order={order()} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    await waitFor(() => expect(m.refresh).toHaveBeenCalled());
    expect(m.recheck).toHaveBeenCalledWith("XS-ABC123");
    expect(await screen.findByText(/Chưa có xác nhận thanh toán/)).toBeInTheDocument();

    m.recheck.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    expect(await screen.findByText(/Mất kết nối — chưa xác định được kết quả/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Đã xác nhận thanh toán|Đã thanh toán/);
  });

  it("Hủy đơn: hộp thoại xác nhận; 'Giữ đơn' không gọi; xác nhận → action + làm mới; PAYMENT_PENDING → thông báo", async () => {
    render(<OrderDetail order={order()} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Hủy đơn" }));
    const dialog = await screen.findByRole("dialog", { name: "Hủy đơn hàng?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Giữ đơn" }));
    expect(m.cancel).not.toHaveBeenCalled();

    m.cancel.mockResolvedValueOnce({ kind: "error", code: "PAYMENT_PENDING", message: "x" });
    fireEvent.click(screen.getByRole("button", { name: "Hủy đơn" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Xác nhận hủy" }));
    expect(await screen.findByText(/Đang xác nhận thanh toán với cổng nên chưa hủy được/)).toBeInTheDocument();

    m.cancel.mockResolvedValueOnce({ kind: "ok", order: order({ state: "cancelled" }), refundRequested: false });
    fireEvent.click(screen.getByRole("button", { name: "Hủy đơn" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Xác nhận hủy" }));
    await waitFor(() => expect(m.refresh).toHaveBeenCalled());
    expect(m.cancel).toHaveBeenCalledWith("XS-ABC123");
    expect(await screen.findByText("Đơn đã được hủy.")).toBeInTheDocument();
  });

  it("không được hủy/kiểm tra → không có nút; hết hạn → hướng dẫn đặt lại", () => {
    render(
      <OrderDetail
        order={order({
          state: "cancelled",
          paymentState: "expired",
          cancelReason: "HOLD_EXPIRED",
          canCancel: false,
          canRecheck: false,
        })}
        now={NOW}
      />,
    );
    expect(screen.queryByRole("button", { name: "Hủy đơn" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kiểm tra lại" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Đặt lại đơn" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chọn lại sản phẩm" })).toHaveAttribute("href", "/tim-kiem");
  });
});

describe("LookupForm (POST01)", () => {
  it("có nhãn cho mã đơn + SĐT, điền sẵn mã, nút gửi; axe sạch", async () => {
    const { container } = render(<LookupForm defaultRef="XS-ABC123" />);
    expect(screen.getByLabelText("Mã đơn hàng")).toHaveValue("XS-ABC123");
    expect(screen.getByLabelText("Số điện thoại đặt hàng")).toHaveAttribute("type", "tel");
    expect(screen.getByRole("button", { name: "Gửi liên kết xem đơn" })).toBeInTheDocument();
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
