/* eslint-disable testing-library/no-container -- kiểm cấu trúc <picture> (không có vai trò ARIA) */
import { render, screen, within } from "@testing-library/react";
import { HOME_CONTENT } from "../lib/content/home";
import HomePage from "./page";

const menu = vi.hoisted(() => ({ only: null as string[] | null }));

vi.mock("../lib/catalog/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/catalog/client")>();
  return {
    ...actual,
    getMenuCategories: async () => {
      const all = await actual.getMenuCategories();
      return menu.only ? all.filter((c) => menu.only!.includes(c.handle)) : all;
    },
  };
});

afterEach(() => {
  menu.only = null;
});

describe("HomePage", () => {
  it("đúng một h1 lấy từ cấu hình, kèm một CTA", async () => {
    render(await HomePage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: HOME_CONTENT.hero.title })).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: HOME_CONTENT.hero.cta.label });
    expect(cta).toHaveAttribute("href", HOME_CONTENT.hero.cta.href);
  });

  it("hero dùng <picture> với ảnh riêng cho desktop, ảnh ưu tiên, alt rỗng (chữ ở HTML)", async () => {
    const { container } = render(await HomePage());
    const picture = container.querySelector("picture")!;
    const source = picture.querySelector("source")!;
    expect(source.getAttribute("media")).toBe("(min-width: 48em)");
    expect(source.getAttribute("srcset")).toContain("hero-desktop");
    const img = picture.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("hero-mobile");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("loading")).not.toBe("lazy");
    expect(img).toHaveAttribute("width", String(HOME_CONTENT.hero.imageMobile.width));
    expect(img).toHaveAttribute("height", String(HOME_CONTENT.hero.imageMobile.height));
  });

  it("có các khối: danh mục, hàng mới (đủ số thẻ cấu hình), phối đồ, thông tin mua hàng — heading h2 có tên", async () => {
    render(await HomePage());
    for (const name of [
      HOME_CONTENT.categories.title,
      HOME_CONTENT.newArrivals.title,
      HOME_CONTENT.lookbook.title,
      HOME_CONTENT.info.title,
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    const arrivals = screen.getByRole("region", { name: HOME_CONTENT.newArrivals.title });
    expect(within(arrivals).getAllByRole("article")).toHaveLength(HOME_CONTENT.newArrivals.limit);
    const info = screen.getByRole("region", { name: HOME_CONTENT.info.title });
    expect(within(info).getByRole("link", { name: "Chính sách giao hàng" })).toHaveAttribute(
      "href",
      "/giao-hang",
    );
    expect(within(info).getByRole("link", { name: "Chính sách đổi trả" })).toHaveAttribute(
      "href",
      "/doi-tra-hoan-tien",
    );
  });

  it("danh mục nổi bật chỉ hiện nhóm có sản phẩm (không link hỏng)", async () => {
    menu.only = ["ao", "quan"];
    render(await HomePage());
    const section = screen.getByRole("region", { name: HOME_CONTENT.categories.title });
    const hrefs = within(section)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/danh-muc/ao", "/danh-muc/quan"]);
  });

  it("không còn danh mục nào có hàng → ẩn cả khối (không khối trống)", async () => {
    menu.only = [];
    render(await HomePage());
    expect(screen.queryByRole("region", { name: HOME_CONTENT.categories.title })).toBeNull();
  });
});
