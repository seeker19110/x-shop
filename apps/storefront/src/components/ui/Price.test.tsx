/* eslint-disable testing-library/no-container -- kiểm phần tử <s> (không có vai trò ARIA) để chứng minh gạch giá */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Price, discountPercent } from "./Price";

describe("Price", () => {
  it("giá đơn: định dạng VND, không gạch", () => {
    const { container } = render(<Price current={1300000} />);
    expect(container).toHaveTextContent("1.300.000 ₫");
    expect(container.querySelector("s")).toBeNull();
  });

  it("giá 0 vẫn hiển thị", () => {
    const { container } = render(<Price current={0} />);
    expect(container).toHaveTextContent("0 ₫");
  });

  it("giá gốc lớn hơn: gạch ngang + text trình đọc 'Giá gốc …, giá hiện tại …'", () => {
    const { container } = render(<Price current={900000} original={1200000} />);
    expect(container.querySelector("s")).toHaveTextContent("1.200.000 ₫");
    expect(screen.getByText("Giá gốc 1.200.000 ₫, giá hiện tại 900.000 ₫")).toBeInTheDocument();
  });

  it.each([900000, 800000, null, undefined])("giá gốc %s không lớn hơn hiện tại: không gạch", (original) => {
    const { container } = render(<Price current={900000} original={original} />);
    expect(container.querySelector("s")).toBeNull();
    expect(screen.queryByText(/Giá gốc/)).toBeNull();
  });

  it("khoảng giá: 'Từ X' khi min khác max; bằng nhau thì giá đơn", () => {
    const { container, rerender } = render(<Price current={500000} max={700000} />);
    expect(container).toHaveTextContent("Từ 500.000 ₫");
    rerender(<Price current={500000} max={500000} />);
    expect(container).not.toHaveTextContent("Từ");
    expect(container).toHaveTextContent("500.000 ₫");
  });

  it("số tiền không hợp lệ ném lỗi thay vì hiển thị sai", () => {
    expect(() => render(<Price current={1.5} />)).toThrow();
  });
});

describe("discountPercent", () => {
  it("làm tròn xuống, null khi không giảm hoặc < 1%", () => {
    expect(discountPercent(750, 1000)).toBe(25);
    expect(discountPercent(666, 1000)).toBe(33);
    expect(discountPercent(1000, 1000)).toBeNull();
    expect(discountPercent(1200, 1000)).toBeNull();
    expect(discountPercent(999, 1000)).toBeNull();
    expect(discountPercent(500, null)).toBeNull();
    expect(discountPercent(0, 1000)).toBe(100);
  });
});
