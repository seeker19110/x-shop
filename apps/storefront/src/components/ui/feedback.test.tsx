import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Breadcrumb } from "./Breadcrumb";
import { EmptyState } from "./EmptyState";
import { InlineError } from "./InlineError";
import { Skeleton } from "./Skeleton";
import { LiveRegion, ToastProvider, useToast } from "./Toast";
import { VisuallyHidden } from "./VisuallyHidden";

describe("Breadcrumb", () => {
  it("nav có aria-label; mục cuối aria-current=page và không là link", () => {
    render(
      <Breadcrumb
        items={[
          { label: "Trang chủ", href: "/" },
          { label: "Áo", href: "/danh-muc/ao" },
          { label: "Áo thun" },
        ]}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Đường dẫn" })).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("Áo thun")).toHaveAttribute("aria-current", "page");
  });

  it("rỗng không render", () => {
    const { container } = render(<Breadcrumb items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("InlineError / EmptyState / Skeleton / VisuallyHidden", () => {
  it("InlineError: role=alert chỉ khi alert", () => {
    const { rerender } = render(<InlineError>Lỗi A</InlineError>);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<InlineError alert>Lỗi A</InlineError>);
    expect(screen.getByRole("alert")).toHaveTextContent("Lỗi A");
  });

  it('EmptyState: action rỗng (false/""/0/null) → không dựng khung hành động', () => {
    for (const action of [false, "", 0, null, undefined]) {
      const { unmount } = render(<EmptyState title="Trống" action={action} />);
      // Chỉ còn tiêu đề trong section — không có khung hành động rỗng.
      expect(screen.getByRole("heading", { name: "Trống" }).parentElement?.childElementCount).toBe(1);
      unmount();
    }
  });

  it("EmptyState: tiêu đề, mô tả, hành động; mô tả/hành động tùy chọn", () => {
    const { rerender } = render(
      <EmptyState
        title="Giỏ hàng trống"
        description="Hãy thêm sản phẩm"
        action={<button>Tiếp tục mua</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Giỏ hàng trống" })).toBeInTheDocument();
    expect(screen.getByText("Hãy thêm sản phẩm")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tiếp tục mua" })).toBeInTheDocument();
    rerender(<EmptyState title="Trống" />);
    expect(screen.getByRole("heading", { name: "Trống" })).toBeInTheDocument();
  });

  it("Skeleton ẩn khỏi trình đọc và giữ tỷ lệ", () => {
    const { container } = render(<Skeleton aspectRatio="4 / 5" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.style.aspectRatio).toBe("4 / 5");
  });

  it("VisuallyHidden vẫn có trong cây truy cập", () => {
    render(<VisuallyHidden>Chỉ cho trình đọc</VisuallyHidden>);
    expect(screen.getByText("Chỉ cho trình đọc")).toHaveClass("visually-hidden");
  });
});

describe("LiveRegion", () => {
  it("role=status, aria-live=polite, không lấy focus", () => {
    const { rerender } = render(<LiveRegion message="" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    rerender(<LiveRegion message="Đã thêm vào giỏ" />);
    expect(screen.getByRole("status")).toHaveTextContent("Đã thêm vào giỏ");
    expect(document.body).toHaveFocus();
  });
});

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Trigger() {
    const { notify } = useToast();
    return <button onClick={() => notify("Đã thêm vào giỏ")}>Thêm</button>;
  }

  it("hiện trong vùng polite, không giật focus, tự tắt sau thời gian", () => {
    render(
      <ToastProvider durationMs={6000}>
        <Trigger />
      </ToastProvider>,
    );
    const btn = screen.getByRole("button", { name: "Thêm" });
    btn.focus();
    fireEvent.click(btn);
    expect(screen.getByText("Đã thêm vào giỏ")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(btn).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(6001);
    });
    expect(screen.queryByText("Đã thêm vào giỏ")).toBeNull();
  });

  it("nút đóng gỡ thông báo", () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thêm" }));
    fireEvent.click(screen.getByRole("button", { name: "Đóng thông báo" }));
    expect(screen.queryByText("Đã thêm vào giỏ")).toBeNull();
  });

  it("useToast ngoài provider ném lỗi rõ ràng", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
