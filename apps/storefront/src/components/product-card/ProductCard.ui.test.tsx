/* eslint-disable testing-library/no-container -- đếm <img> trang trí alt rỗng (vai trò presentation, không truy vấn được theo role) */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductCard, type ProductCardProps } from "./ProductCard";

const base: ProductCardProps = {
  slug: "ao-thun-co-tron",
  name: "Áo thun cổ tròn",
  image: { src: "/img/ao-1.jpg", alt: "Áo thun cổ tròn màu đen, mặt trước" },
  price: 450000,
};

const colors = ["Đen", "Trắng", "Xám", "Be", "Xanh", "Đỏ", "Nâu"].map((name, i) => ({
  value: `c${i}`,
  name,
  hex: "#222222",
}));

describe("ProductCard", () => {
  it("đúng một link chính tới /san-pham/[slug], không lồng link", () => {
    render(<ProductCard {...base} colors={colors} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/san-pham/ao-thun-co-tron");
    expect(links[0]).toHaveAccessibleName("Áo thun cổ tròn");
  });

  it("ảnh có alt ý nghĩa và sizes cho lưới 2/3/4 cột", () => {
    render(<ProductCard {...base} />);
    const img = screen.getByAltText("Áo thun cổ tròn màu đen, mặt trước");
    expect(img).toHaveAttribute("sizes", "(min-width: 72em) 25vw, (min-width: 48em) 33vw, 50vw");
  });

  it("ảnh thứ hai là trang trí (alt rỗng) và tùy chọn", () => {
    const { container, rerender } = render(<ProductCard {...base} />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    rerender(<ProductCard {...base} hoverImage={{ src: "/img/ao-2.jpg" }} />);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[1]).toHaveAttribute("alt", "");
  });

  it("swatch: tối đa 5 + '+N', mỗi màu có tên truy cập", () => {
    render(<ProductCard {...base} colors={colors} />);
    const list = screen.getByRole("list", { name: "Màu có sẵn" });
    expect(within(list).getAllByRole("img")).toHaveLength(5);
    expect(within(list).getByRole("img", { name: "Đen" })).toBeInTheDocument();
    expect(within(list).getByText("+2")).toBeInTheDocument();
    expect(within(list).getByText("và 2 màu khác")).toBeInTheDocument();
  });

  it("đúng 5 màu: không có '+N'; không màu: không có danh sách", () => {
    const { rerender } = render(<ProductCard {...base} colors={colors.slice(0, 5)} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
    rerender(<ProductCard {...base} />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("nhãn Giảm x% khi giá gốc lớn hơn; không nhãn khi bằng/nhỏ hơn", () => {
    const { rerender } = render(<ProductCard {...base} price={300000} originalPrice={400000} />);
    expect(screen.getByText("Giảm 25%")).toBeInTheDocument();
    rerender(<ProductCard {...base} price={400000} originalPrice={400000} />);
    expect(screen.queryByText(/Giảm/)).toBeNull();
    rerender(<ProductCard {...base} price={500000} originalPrice={400000} />);
    expect(screen.queryByText(/Giảm/)).toBeNull();
  });

  it("hết hàng: nhãn chữ 'Hết hàng', không hiện nhãn giảm giá", () => {
    render(<ProductCard {...base} price={300000} originalPrice={400000} soldOut />);
    expect(screen.getByText("Hết hàng")).toBeInTheDocument();
    expect(screen.queryByText(/Giảm/)).toBeNull();
  });

  it("khoảng giá: 'Từ X', không nhãn giảm", () => {
    render(<ProductCard {...base} price={300000} maxPrice={500000} originalPrice={600000} />);
    expect(screen.getByText("Từ 300.000 ₫")).toBeInTheDocument();
    expect(screen.queryByText(/Giảm/)).toBeNull();
  });

  it("slug có ký tự đặc biệt được mã hóa trong href", () => {
    render(<ProductCard {...base} slug="a b/c" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/san-pham/a%20b%2Fc");
  });
});
