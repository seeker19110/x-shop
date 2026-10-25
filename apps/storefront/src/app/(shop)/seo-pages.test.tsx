import { render } from "@testing-library/react";
import CategoryPage, { generateMetadata as categoryMeta } from "./danh-muc/[slug]/page";
import ProductPage, { generateMetadata as productMeta } from "./san-pham/[slug]/page";
import { generateMetadata as rootMeta } from "../layout";
import { metadata as homeMeta } from "../page";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}));

const ldBlocks = (c: HTMLElement) =>
  [...c.querySelectorAll('script[type="application/ld+json"]')].map((e) => JSON.parse(e.textContent!));

describe("seo: metadata và JSON-LD trang công khai", () => {
  it("mặc định: metadataBase, title template, description, openGraph", () => {
    const m = rootMeta();
    expect(String(m.metadataBase)).toBe("http://localhost:3000/");
    expect(m.title).toMatchObject({ default: "X-Shop", template: "%s | X-Shop" });
    expect(m.description).toBeTruthy();
    expect(m.openGraph).toMatchObject({ type: "website", siteName: "X-Shop" });
    expect(homeMeta.alternates?.canonical).toBe("/");
  });

  it("PDP: biến thể ?color=&size= cùng canonical gốc; sản phẩm không có → noindex", async () => {
    const m = await productMeta({
      params: Promise.resolve({ slug: "ao-so-mi-oxford" }),
      searchParams: Promise.resolve({ color: "den", size: "m" }),
    });
    expect(m.alternates?.canonical).toBe("/san-pham/ao-so-mi-oxford");
    const missing = await productMeta({
      params: Promise.resolve({ slug: "khong-co" }),
      searchParams: Promise.resolve({}),
    });
    expect(missing.robots).toMatchObject({ index: false });
  });

  it("PDP không tồn tại → notFound (404)", async () => {
    await expect(
      ProductPage({ params: Promise.resolve({ slug: "khong-co" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
  });

  it("PDP: ProductGroup rồi BreadcrumbList (Trang chủ > Danh mục > Sản phẩm)", async () => {
    const { container } = render(
      await ProductPage({
        params: Promise.resolve({ slug: "ao-so-mi-oxford" }),
        searchParams: Promise.resolve({}),
      }),
    );
    const [group, crumbs] = ldBlocks(container);
    expect(group["@type"]).toBe("ProductGroup");
    expect(crumbs["@type"]).toBe("BreadcrumbList");
    expect(crumbs.itemListElement.map((i: { item: string }) => i.item)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/danh-muc/ao",
      "http://localhost:3000/san-pham/ao-so-mi-oxford",
    ]);
  });

  it("danh mục: gốc index; lọc khác mặc định noindex,follow với canonical chính nó; có BreadcrumbList", async () => {
    const meta = (sp: Record<string, string>) =>
      categoryMeta({ params: Promise.resolve({ slug: "ao" }), searchParams: Promise.resolve(sp) });
    expect((await meta({})).robots).toMatchObject({ index: true, follow: true });
    const filtered = await meta({ size: "m" });
    expect(filtered.robots).toMatchObject({ index: false, follow: true });
    expect(String(filtered.alternates?.canonical)).toContain("size=m");
    const { container } = render(
      await CategoryPage({ params: Promise.resolve({ slug: "ao" }), searchParams: Promise.resolve({}) }),
    );
    const [crumbs] = ldBlocks(container);
    expect(crumbs["@type"]).toBe("BreadcrumbList");
    expect(crumbs.itemListElement).toHaveLength(2);
  });
});
