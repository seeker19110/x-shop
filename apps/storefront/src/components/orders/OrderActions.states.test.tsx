// UX-STATE-001: 4 trạng thái của OrderActions (kiểm tra lại / hủy đơn qua Server Action).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";

const m = vi.hoisted(() => ({ refresh: vi.fn(), recheck: vi.fn(), cancel: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh }) }));
vi.mock("../../lib/orders/actions", () => ({ recheckOrderAction: m.recheck, cancelOrderAction: m.cancel }));

import { OrderActions } from "./OrderActions";

beforeEach(() => Object.values(m).forEach((f) => f.mockReset()));

const ui = (p: Partial<ComponentProps<typeof OrderActions>> = {}) =>
  render(<OrderActions orderRef="XS-ABC123" canRecheck canCancel paid={false} {...p} />);

describe("OrderActions — 4 trạng thái", () => {
  it("loading: đang kiểm tra → nút aria-busy 'Đang kiểm tra', nút khác bị khóa", async () => {
    let done: (r: unknown) => void = () => undefined;
    m.recheck.mockImplementation(() => new Promise((r) => (done = r)));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    expect(await screen.findByRole("button", { name: /Đang kiểm tra/ })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Hủy đơn" })).toBeDisabled();
    await act(async () => done({ kind: "ok", order: { paymentState: "pending" } }));
  });

  it("empty: không có thao tác nào khả dụng → không hiển thị gì", () => {
    const { container } = ui({ canRecheck: false, canCancel: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("error: mất mạng → báo 'chưa xác định', không khẳng định đã thanh toán; nút dùng lại được", async () => {
    m.recheck.mockRejectedValue(new TypeError("offline"));
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Kiểm tra lại" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/Mất kết nối — chưa xác định được kết quả/),
    );
    expect(screen.getByRole("status").textContent).not.toMatch(/Đã xác nhận thanh toán/);
    expect(screen.getByRole("button", { name: "Kiểm tra lại" })).toBeEnabled();
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it("success: hủy đơn có xác nhận → báo 'Đơn đã được hủy.' và dựng lại trang từ server", async () => {
    m.cancel.mockResolvedValue({ kind: "ok", refundRequested: false });
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Hủy đơn" }));
    fireEvent.click(await screen.findByRole("button", { name: "Xác nhận hủy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Đơn đã được hủy."));
    expect(m.cancel).toHaveBeenCalledWith("XS-ABC123");
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });
});
