import { fireEvent, render, screen } from "@testing-library/react";
import { MobileMenu } from "./MobileMenu";

const items = [
  { handle: "ao", name: "Áo" },
  { handle: "quan", name: "Quần" },
];

describe("MobileMenu (layout)", () => {
  it("đóng mặc định; mở bằng nút → dialog Drawer chứa link danh mục", () => {
    render(<MobileMenu items={items} />);
    const btn = screen.getByRole("button", { name: "Mở menu danh mục" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(btn);
    const dialog = screen.getByRole("dialog", { name: "Danh mục" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(dialog.querySelector("a[href='/danh-muc/ao']")?.textContent).toBe("Áo");
    expect(dialog.querySelectorAll("a")).toHaveLength(2);
  });

  it("Esc đóng và trả focus về nút mở", () => {
    render(<MobileMenu items={items} />);
    const btn = screen.getByRole("button", { name: "Mở menu danh mục" });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(btn).toHaveFocus();
  });

  it("bấm link trong menu thì đóng drawer", () => {
    render(<MobileMenu items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Mở menu danh mục" }));
    fireEvent.click(screen.getByRole("link", { name: "Quần" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("không có danh mục → báo rõ thay vì menu rỗng", () => {
    render(<MobileMenu items={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mở menu danh mục" }));
    expect(screen.getByText("Chưa có danh mục.")).toBeInTheDocument();
  });
});
