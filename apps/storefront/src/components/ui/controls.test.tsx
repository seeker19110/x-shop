import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Chip, ChipList } from "./Chip";
import { IconButton } from "./IconButton";

describe("Button", () => {
  it("là button type=button, gọi onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Thêm vào giỏ</Button>);
    const btn = screen.getByRole("button", { name: "Thêm vào giỏ" });
    expect(btn).toHaveAttribute("type", "button");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("loading: aria-busy, có chữ cho trình đọc, không kích hoạt lại, vẫn focus được", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Mua ngay
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveTextContent("Đang xử lý");
    btn.focus();
    expect(btn).toHaveFocus();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled: không kích hoạt", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Mua
      </Button>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("có href: render link tới đúng đích; loading chặn điều hướng", () => {
    const { rerender } = render(<Button href="/gio-hang">Xem giỏ</Button>);
    expect(screen.getByRole("link", { name: "Xem giỏ" })).toHaveAttribute("href", "/gio-hang");
    rerender(
      <Button href="/gio-hang" loading>
        Xem giỏ
      </Button>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(fireEvent.click(link)).toBe(false); // preventDefault đã gọi
  });

  it("size lg và variant được áp class", () => {
    render(
      <Button size="lg" variant="secondary">
        X
      </Button>,
    );
    const cls = screen.getByRole("button").className;
    expect(cls).toMatch(/lg/);
    expect(cls).toMatch(/secondary/);
  });
});

describe("IconButton", () => {
  it("có tên truy cập từ label; biểu tượng ẩn khỏi trình đọc", () => {
    const onClick = vi.fn();
    render(<IconButton label="Mở giỏ hàng" icon="🛒" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Mở giỏ hàng" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
    expect(btn.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("Chip / ChipList", () => {
  it("nút gỡ có aria-label 'Bỏ lọc: Đen' và gọi onRemove", () => {
    const onRemove = vi.fn();
    render(<Chip label="Đen" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Bỏ lọc: Đen" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("ChipList rỗng không render gì", () => {
    const { container } = render(<ChipList items={[]} onRemove={() => {}} onClearAll={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gỡ từng chip và Xóa tất cả", () => {
    const onRemove = vi.fn();
    const onClearAll = vi.fn();
    render(
      <ChipList
        items={[
          { key: "color:den", label: "Đen" },
          { key: "size:m", label: "M" },
        ]}
        onRemove={onRemove}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Bỏ lọc: M" }));
    expect(onRemove).toHaveBeenCalledWith("size:m");
    fireEvent.click(screen.getByRole("button", { name: "Xóa tất cả" }));
    expect(onClearAll).toHaveBeenCalled();
  });

  it("hoạt động trong component có state", () => {
    function Demo() {
      const [items, setItems] = useState([{ key: "a", label: "Áo" }]);
      return (
        <ChipList
          items={items}
          onRemove={(k) => setItems((xs) => xs.filter((x) => x.key !== k))}
          onClearAll={() => setItems([])}
        />
      );
    }
    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "Bỏ lọc: Áo" }));
    expect(screen.queryByRole("list")).toBeNull();
  });
});
