// UX-STATE-001: 4 trạng thái của LookupForm (tra cứu đơn qua Server Action + useActionState).
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LookupState } from "../../lib/orders/types";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("../../lib/orders/actions", () => ({ lookupOrderAction: lookup }));

import { LookupForm } from "./LookupForm";

beforeEach(() => {
  lookup.mockReset();
});

const fill = () => {
  fireEvent.change(screen.getByLabelText("Mã đơn hàng"), { target: { value: "XS-ABC123" } });
  fireEvent.change(screen.getByLabelText("Số điện thoại đặt hàng"), { target: { value: "0912345678" } });
};
const formEl = () => screen.getByRole("button", { name: /Gửi liên kết xem đơn|Đang gửi/ }).closest("form")!;
const submit = async () => {
  fill();
  await act(async () => {
    fireEvent.submit(formEl());
  });
};

describe("LookupForm — 4 trạng thái", () => {
  it("loading: đang gửi → nút khóa (aria-busy) và có chữ 'Đang gửi' cho trình đọc", async () => {
    let done: (s: LookupState) => void = () => undefined;
    lookup.mockImplementation(() => new Promise<LookupState>((r) => (done = r)));
    render(<LookupForm />);
    fill();
    // Ngoài act: để React hiển thị trạng thái pending của hành động đang chạy dở.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      fireEvent.submit(formEl());
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: /Đang gửi/ })).toHaveAttribute("aria-busy", "true"),
      );
      done({ status: "idle" });
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: "Gửi liên kết xem đơn" })).not.toHaveAttribute("aria-busy"),
      );
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("empty: chưa gửi hoặc gửi trống → không thông báo; lỗi trường gắn aria-describedby vào ô nhập", async () => {
    render(<LookupForm />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
    lookup.mockResolvedValue({ status: "invalid", field: "phone", message: "Vui lòng nhập số điện thoại." });
    await submit();
    expect(await screen.findByText("Vui lòng nhập số điện thoại.")).toBeInTheDocument();
    const phone = screen.getByLabelText("Số điện thoại đặt hàng");
    expect(phone).toHaveAttribute("aria-invalid", "true");
    expect(phone).toHaveAttribute("aria-describedby", "tra-cuu-sdt-loi");
  });

  it("error: giới hạn tần suất/lỗi hệ thống → vùng role=alert tiếng Việt, form dùng lại được", async () => {
    render(<LookupForm />);
    lookup.mockResolvedValue({
      status: "rate_limited",
      message: "Bạn thử quá nhiều lần. Vui lòng thử lại sau.",
    });
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bạn thử quá nhiều lần. Vui lòng thử lại sau.",
    );
    expect(screen.getByRole("button", { name: "Gửi liên kết xem đơn" })).toBeEnabled();
  });

  it("success: đã gửi → thông điệp trung tính trong vùng aria-live, không có alert", async () => {
    render(<LookupForm />);
    lookup.mockResolvedValue({
      status: "sent",
      message: "Nếu thông tin khớp, liên kết xem đơn đã được gửi.",
    });
    await submit();
    expect(await screen.findByText("Nếu thông tin khớp, liên kết xem đơn đã được gửi.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Nếu thông tin khớp, liên kết xem đơn đã được gửi.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
