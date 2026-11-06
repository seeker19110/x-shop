import { render, screen } from "@testing-library/react";
import Loading from "./loading";
import ShopLoading from "./(shop)/loading";

describe("loading.tsx (UX-STATE-001)", () => {
  it("(shop): vùng status đọc được thông báo tiếng Việt, skeleton busy và ẩn khỏi trình đọc", () => {
    render(<ShopLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải nội dung…");
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy");
    expect(screen.queryAllByRole("generic", { busy: true })).toHaveLength(0);
  });

  it("trang chủ: vùng status có chuỗi thông báo, không để aria-busy trên live region", () => {
    render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Đang tải nội dung…");
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy");
  });
});
