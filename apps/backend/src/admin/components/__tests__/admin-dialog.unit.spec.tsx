/** @jest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "../confirm-dialog";
import { confirmSpec } from "../../lib/confirm-dialog";

afterEach(cleanup);

const refundSpec = () => confirmSpec("refund-execute", { ref: "RF-0001", amount: 150000 });

describe("admin-dialog: nội dung (confirmSpec)", () => {
  it("hoàn tiền: nêu mã, số tiền VND, hậu quả không hoàn tác; nút là động từ + số tiền", () => {
    const s = refundSpec();
    expect(s.object).toContain("RF-0001");
    expect(s.object).toContain("150.000 ₫");
    expect(s.consequence).toMatch(/không thể hoàn tác/);
    expect(s.confirmLabel).toBe("Hoàn tiền 150.000 ₫");
  });
  it("hủy đơn chưa xác minh / từ chối: nhãn đúng động từ", () => {
    expect(confirmSpec("order-cancel-unverified", { ref: "#1001" }).confirmLabel).toBe("Hủy đơn");
    expect(confirmSpec("refund-reject", { ref: "RF-2", amount: 5 }).confirmLabel).toBe("Từ chối");
    expect(confirmSpec("return-reject", { ref: "RT-2" }).confirmLabel).toBe("Từ chối");
  });
  it("biên: số tiền 0 vẫn in, null/âm/không nguyên không bịa; mã rỗng/Unicode", () => {
    expect(confirmSpec("refund-execute", { ref: "A", amount: 0 }).confirmLabel).toBe("Hoàn tiền 0 ₫");
    for (const amount of [null, undefined, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(confirmSpec("refund-execute", { ref: "A", amount }).confirmLabel).toBe("Hoàn tiền");
    }
    expect(confirmSpec("refund-reject", { ref: "  " }).object).toContain("(không rõ mã)");
    expect(confirmSpec("refund-reject", { ref: "Đơn Ấ-Ế" }).object).toContain("Đơn Ấ-Ế");
  });
  it("không dùng nhãn OK/Có", () => {
    for (const k of [
      "refund-execute",
      "order-cancel-unverified",
      "refund-reject",
      "return-reject",
    ] as const) {
      expect(confirmSpec(k, { ref: "x", amount: 1 }).confirmLabel).not.toMatch(/^(ok|có)$/i);
    }
  });
});

describe("admin-dialog: component", () => {
  it("hiển thị đối tượng + hậu quả + nút; focus mặc định ở nút Hủy bỏ", async () => {
    render(<ConfirmDialog spec={refundSpec()} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(await screen.findByText(/RF-0001/)).toBeTruthy();
    expect(screen.getByText(/không thể hoàn tác/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hoàn tiền 150.000 ₫" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hủy bỏ" }));
  });

  it("spec=null: không render hộp thoại", () => {
    render(<ConfirmDialog spec={null} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Esc → không gọi action, gọi onCancel", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<ConfirmDialog spec={refundSpec()} onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("nút Hủy bỏ → không gọi action", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(<ConfirmDialog spec={refundSpec()} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(await screen.findByRole("button", { name: "Hủy bỏ" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("xác nhận → gọi đúng một lần", async () => {
    const onConfirm = jest.fn();
    render(<ConfirmDialog spec={refundSpec()} onConfirm={onConfirm} onCancel={jest.fn()} />);
    const btn = await screen.findByRole("button", { name: "Hoàn tiền 150.000 ₫" });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("double-click (action chưa xong) → vẫn một lần", async () => {
    let release!: () => void;
    const onConfirm = jest.fn(() => new Promise<void>((r) => (release = r)));
    render(<ConfirmDialog spec={refundSpec()} onConfirm={onConfirm} onCancel={jest.fn()} />);
    const btn = await screen.findByRole("button", { name: "Hoàn tiền 150.000 ₫" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.doubleClick(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
});
