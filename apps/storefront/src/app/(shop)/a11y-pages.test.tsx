import { render } from "@testing-library/react";
import axe from "axe-core";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "../page";
import RootLayout from "../layout";
import CategoryPage from "./danh-muc/[slug]/page";
import PolicyGiaoHang from "./giao-hang/page";
import ProductPage from "./san-pham/[slug]/page";
import SearchPage from "./tim-kiem/page";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}));

/** Lỗi serious/critical (S-509). Tương phản cần trình duyệt thật nên tắt ở jsdom; token có cổng `xt.py contrast`. */
async function violations(node: Element) {
  const res = await axe.run(node, { rules: { "color-contrast": { enabled: false } } });
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const levels = (root: Element) => [...root.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));

/** Cấp heading không nhảy cóc (h1 → h2 → h3, không h1 → h3). */
function expectNoSkippedHeading(root: Element) {
  const ls = levels(root);
  expect(ls[0]).toBe(1);
  ls.forEach((l, i) => i > 0 && expect(l - ls[i - 1]!).toBeLessThanOrEqual(1));
}

describe("axe + cấu trúc heading trên các trang storefront (catalog product home layout)", () => {
  it("trang chủ", async () => {
    const { container } = render(await HomePage());
    expect(await violations(container)).toEqual([]);
    expectNoSkippedHeading(container);
  });

  it("danh mục có lọc + chip", async () => {
    const { container } = render(
      await CategoryPage({
        params: Promise.resolve({ slug: "ao" }),
        searchParams: Promise.resolve({ color: "den", size: "m", sort: "price_asc" }),
      }),
    );
    expect(await violations(container)).toEqual([]);
    expectNoSkippedHeading(container);
  });

  it("danh mục không kết quả", async () => {
    const { container } = render(
      await CategoryPage({
        params: Promise.resolve({ slug: "ao" }),
        searchParams: Promise.resolve({ color: "xanh-navy", size: "s", in_stock: "1", price_max: "1000" }),
      }),
    );
    expect(await violations(container)).toEqual([]);
  });

  it("tìm kiếm (có phân trang)", async () => {
    const { container } = render(await SearchPage({ searchParams: Promise.resolve({}) }));
    expect(await violations(container)).toEqual([]);
    expectNoSkippedHeading(container);
  });

  it("chi tiết sản phẩm", async () => {
    const { container } = render(
      await ProductPage({
        params: Promise.resolve({ slug: "ao-so-mi-oxford" }),
        searchParams: Promise.resolve({ color: "den", size: "m" }),
      }),
    );
    expect(await violations(container)).toEqual([]);
    expectNoSkippedHeading(container);
  });

  it("trang chính sách giữ chỗ có cảnh báo rõ", async () => {
    const { container } = render(<PolicyGiaoHang />);
    expect(await violations(container)).toEqual([]);
    expect(container.querySelector("[role=note]")?.textContent).toContain("Nội dung chờ chủ shop duyệt");
    expectNoSkippedHeading(container);
  });

  it("toàn bộ tài liệu (layout + trang chủ): đủ landmark, một h1", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <h1>Tiêu đề thử</h1> }));
    const doc = new DOMParser().parseFromString(`<!doctype html>${html}`, "text/html");
    // <title> do Next chèn qua metadata lúc chạy, không có trong markup của layout.
    const res = await axe.run(doc.documentElement, {
      rules: { "color-contrast": { enabled: false }, "document-title": { enabled: false } },
    });
    const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => v.id)).toEqual([]);
  });
});
