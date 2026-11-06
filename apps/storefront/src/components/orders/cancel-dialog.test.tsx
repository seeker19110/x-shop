import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrderActions } from "./OrderActions";

const m = vi.hoisted(() => ({ cancel: vi.fn(), recheck: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../lib/orders/actions", () => ({
  recheckOrderAction: m.recheck,
  cancelOrderAction: m.cancel,
}));

beforeEach(() => {
  m.cancel.mockReset();
  m.recheck.mockReset();
});

const open = (paid = false) => {
  render(<OrderActions orderRef="XS-ABC123" canRecheck={false} canCancel paid={paid} />);
  const trigger = screen.getByRole("button", { name: "Hủy đơn" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};

describe("hộp thoại hủy đơn (UX-STATE-008)", () => {
  it("nêu mã đơn, hậu quả không hoàn tác; focus rơi vào nút an toàn 'Giữ đơn'", async () => {
    open();
    const dialog = await screen.findByRole("dialog", { name: "Hủy đơn XS-ABC123?" });
    expect(dialog).toHaveTextContent("XS-ABC123");
    expect(dialog).toHaveTextContent("không thể hoàn tác");
    expect(dialog).toHaveTextContent("trả lại kho");
    expect(screen.getByRole("button", { name: "Giữ đơn" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Xác nhận hủy" })).toBeInTheDocument();
  });

  it("đã thanh toán: nêu hậu quả hoàn tiền", async () => {
    open(true);
    expect(await screen.findByRole("dialog")).toHaveTextContent("hoàn tiền");
  });

  it("Esc đóng, KHÔNG gọi hủy, trả focus về nút Hủy đơn", async () => {
    const trigger = open();
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(m.cancel).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("Giữ đơn đóng, không hủy", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Giữ đơn" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(m.cancel).not.toHaveBeenCalled();
  });
});
