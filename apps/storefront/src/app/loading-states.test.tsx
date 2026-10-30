import { render, screen } from "@testing-library/react";
import Loading from "./loading";
import ShopLoading from "./(shop)/loading";

describe("loading.tsx (UX-STATE-001)", () => {
  it("(shop): vùng status aria-busy kèm thông báo tiếng Việt", () => {
    render(<ShopLoading />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveTextContent("Đang tải nội dung…");
  });

  it("trang chủ: vùng status aria-busy (biến thể hero)", () => {
    render(<Loading />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
  });
});
