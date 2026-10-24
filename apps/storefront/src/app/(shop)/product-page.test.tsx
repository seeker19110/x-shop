import { render, screen, within } from "@testing-library/react";
import ProductPage, { generateMetadata } from "./san-pham/[slug]/page";

type Sp = Record<string, string | string[] | undefined>;

async function page(slug: string, sp: Sp = {}) {
  return ProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) });
}
const meta = (slug: string, sp: Sp = {}) =>
  generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) });

function jsonLd(container: HTMLElement) {
  const el = container.querySelector('script[type="application/ld+json"]')!;
  return JSON.parse(el.textContent!) as {
    "@type": string;
    hasVariant: Array<{ sku: string; offers: { price: number; availability: string } }>;
  };
}

describe("trang /san-pham/[slug] (product)", () => {
  it("server-render: breadcrumb, h1 duy nhất, khối mua và chi tiết (chất liệu, xuất xứ…)", async () => {
    render(await page("ao-so-mi-lua"));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Áo sơ mi lụa");
    const crumbs = screen.getByRole("navigation", { name: "Đường dẫn" });
    expect(within(crumbs).getByRole("link", { name: "Áo" })).toHaveAttribute("href", "/danh-muc/ao");
    expect(within(crumbs).getByText("Áo sơ mi lụa")).toHaveAttribute("aria-current", "page");
    const details = screen.getByRole("region", { name: "Chi tiết sản phẩm" });
    for (const [k, v] of [
      ["Chất liệu", "Lụa"],
      ["Thành phần", "100% lụa tơ tằm"],
      ["Form", "Suông"],
      ["Bảo quản", "Giặt tay, phơi bóng râm."],
      ["Xuất xứ", "Việt Nam"],
    ] as const) {
      expect(within(details).getByText(k)).toBeInTheDocument();
      expect(within(details).getByText(v)).toBeInTheDocument();
    }
    // Thuộc tính không có dữ liệu (độ co giãn) không được bịa ra.
    expect(within(details).queryByText("Độ co giãn")).toBeNull();
  });

  it("không có sản phẩm → 404 (notFound), metadata noindex", async () => {
    await expect(page("khong-co")).rejects.toThrow();
    expect((await meta("khong-co")).robots).toEqual({ index: false });
  });

  it("?color=&size= mở đúng biến thể ngay trong HTML đầu tiên", async () => {
    render(await page("ao-so-mi-lua", { color: "trang", size: "m" }));
    expect(screen.getByRole("button", { name: /^Trắng/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^M/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector("button[data-cta]")).toHaveTextContent("Thêm vào giỏ");
  });

  it("tham số biến thể sai → về mặc định, không lỗi", async () => {
    render(await page("ao-so-mi-lua", { color: "tim", size: "zz" }));
    expect(screen.getByRole("button", { name: /^Đen/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector("button[data-cta]")).toHaveTextContent("Chọn size");
  });

  it("JSON-LD trong HTML khớp giá/tồn của từng SKU hiển thị trên UI", async () => {
    const { container } = render(await page("ao-so-mi-oxford"));
    const data = jsonLd(container);
    expect(data["@type"]).toBe("ProductGroup");
    expect(data.hasVariant).toHaveLength(9);
    const navyL = data.hasVariant.find((v) => v.sku === "OXF-XANH-NAVY-L")!;
    expect(navyL.offers.availability).toBe("https://schema.org/OutOfStock");
    expect(data.hasVariant.every((v) => v.offers.price === 520000)).toBe(true);
    // UI cùng dữ kiện: mở đúng SKU hết hàng → CTA "Hết hàng".
    document.body.innerHTML = "";
    render(await page("ao-so-mi-oxford", { color: "xanh-navy", size: "l" }));
    expect(document.querySelector("button[data-cta]")).toHaveTextContent("Hết hàng");
  });

  it("metadata: canonical luôn là trang sản phẩm gốc dù có ?color=&size=; title/description/ảnh OG", async () => {
    const m = await meta("ao-so-mi-lua", { color: "trang", size: "m" });
    expect(m.alternates?.canonical).toBe("/san-pham/ao-so-mi-lua");
    expect(m.title).toBe("Áo sơ mi lụa");
    expect(String(m.description)).toContain("Áo sơ mi lụa");
    expect(String(m.description).length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(m.openGraph)).toContain("/demo/top-den-front.svg");
  });
});
