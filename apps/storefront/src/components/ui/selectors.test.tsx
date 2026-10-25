import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColorSwatchGroup } from "./ColorSwatch";
import { SizeSelector, type SizeOption } from "./SizeSelector";

const sizes: SizeOption[] = [
  { value: "S", available: true },
  { value: "M", available: true },
  { value: "L", available: false },
];

describe("SizeSelector", () => {
  it("mỗi size một button có aria-pressed; đúng size được chọn", () => {
    render(<SizeSelector options={sizes} value="M" onChange={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "M" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "S" })).toHaveAttribute("aria-pressed", "false");
  });

  it("chọn size còn hàng gọi onChange", () => {
    const onChange = vi.fn();
    render(<SizeSelector options={sizes} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "S" }));
    expect(onChange).toHaveBeenCalledWith("S");
  });

  it("size hết hàng: có chữ 'hết hàng', focus được, không chọn được", () => {
    const onChange = vi.fn();
    render(<SizeSelector options={sizes} value="L" onChange={onChange} />);
    const l = screen.getByRole("button", { name: /L.*hết hàng/ });
    expect(l).toHaveTextContent("hết hàng");
    expect(l).toHaveAttribute("aria-disabled", "true");
    expect(l).not.toBeDisabled();
    l.focus();
    expect(l).toHaveFocus();
    fireEvent.click(l);
    fireEvent.keyDown(l, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    // giá trị cũ là size hết hàng thì không hiển thị là đã chọn
    expect(l).toHaveAttribute("aria-pressed", "false");
  });

  it("lỗi chưa chọn: nhóm có aria-describedby trỏ tới thông báo; không lỗi thì không có", () => {
    const { rerender } = render(<SizeSelector options={sizes} value={null} onChange={() => {}} />);
    expect(screen.getByRole("group")).not.toHaveAttribute("aria-describedby");
    rerender(<SizeSelector options={sizes} value={null} onChange={() => {}} error="Vui lòng chọn size" />);
    const group = screen.getByRole("group");
    const err = screen.getByText("Vui lòng chọn size");
    expect(group.getAttribute("aria-describedby")).toBe(err.closest("p")?.id);
  });

  it("có liên kết Hướng dẫn chọn size khi truyền href", () => {
    render(
      <SizeSelector options={sizes} value={null} onChange={() => {}} sizeGuideHref="/huong-dan-chon-size" />,
    );
    expect(screen.getByRole("link", { name: "Hướng dẫn chọn size" })).toHaveAttribute(
      "href",
      "/huong-dan-chon-size",
    );
  });

  it("danh sách rỗng không lỗi", () => {
    render(<SizeSelector options={[]} value={null} onChange={() => {}} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("ColorSwatchGroup", () => {
  const colors = [
    { value: "den", name: "Đen", hex: "#111111" },
    { value: "trang", name: "Trắng", imageUrl: "/sw/trang.jpg" },
    { value: "do", name: "Đỏ", hex: "#aa0000", available: false },
  ];

  it("mỗi màu có tên truy cập; hết hàng ghi trong tên", () => {
    render(<ColorSwatchGroup options={colors} value={null} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Đen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trắng" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đỏ (hết hàng)" })).toBeInTheDocument();
  });

  it("chọn: aria-pressed, hiện tên màu và dấu ✓ (không chỉ màu)", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ColorSwatchGroup options={colors} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Trắng" }));
    expect(onChange).toHaveBeenCalledWith("trang");
    rerender(<ColorSwatchGroup options={colors} value="trang" onChange={onChange} />);
    const btn = screen.getByRole("button", { name: "Trắng" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveTextContent("✓");
    expect(screen.getByText(": Trắng")).toBeInTheDocument();
  });

  it("ảnh swatch dùng background-image, mã màu dùng background-color", () => {
    render(<ColorSwatchGroup options={colors} value={null} onChange={() => {}} />);
    const img = screen.getByRole("button", { name: "Trắng" }).firstElementChild as HTMLElement;
    expect(img.style.backgroundImage).toContain("/sw/trang.jpg");
    const hex = screen.getByRole("button", { name: "Đen" }).firstElementChild as HTMLElement;
    expect(hex.style.backgroundColor).not.toBe("");
  });
});
