import { render, screen, within } from "@testing-library/react";
import CategoryPage, { generateMetadata as categoryMeta } from "./danh-muc/[slug]/page";
import SearchPage, { generateMetadata as searchMeta } from "./tim-kiem/page";
import { GET as countRoute } from "../api/catalog/count/route";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}));

type Params = Record<string, string | string[] | undefined>;

async function category(slug: string, sp: Params = {}) {
  render(await CategoryPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }));
}
async function searchPage(sp: Params = {}) {
  render(await SearchPage({ searchParams: Promise.resolve(sp) }));
}
const hrefOf = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");

describe("trang danh mục /danh-muc/[slug] (catalog)", () => {
  it("h1 là tên danh mục, số kết quả, lưới thẻ, heading đúng cấp (h1 → h2 ẩn → h3 thẻ)", async () => {
    await category("ao");
    expect(screen.getByRole("heading", { level: 1, name: "Áo" })).toBeInTheDocument();
    expect(screen.getByText("6 sản phẩm")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(6);
    expect(screen.getByRole("heading", { level: 2, name: "Danh sách sản phẩm" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("danh mục không có trong cấu hình → 404 (notFound)", async () => {
    await expect(
      CategoryPage({ params: Promise.resolve({ slug: "khong-co" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
  });

  it("chip: gỡ đúng điều kiện bằng liên kết tới URL chuẩn; 'Xóa tất cả' về gốc; không còn thiếu giá trị nào khác", async () => {
    await category("ao", { size: "m", color: "den" });
    const chips = screen.getByRole("list", { name: "Bộ lọc đang áp" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(2);
    expect(hrefOf("Bỏ lọc: Màu: Đen")).toBe("/danh-muc/ao?size=m");
    expect(hrefOf("Bỏ lọc: Size: M")).toBe("/danh-muc/ao?color=den");
    expect(hrefOf("Xóa tất cả")).toBe("/danh-muc/ao");
    // AT01 + AT31: sơ mi lụa (chỉ đen-S, trắng-M) KHÔNG khớp đen + M.
    expect(screen.getByText("4 sản phẩm")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Áo sơ mi lụa/ })).toBeNull();
  });

  it("nút 'Bộ lọc (N)' đếm điều kiện đã chốt trong URL", async () => {
    await category("ao", { color: "den,trang", in_stock: "1" });
    expect(screen.getByRole("button", { name: "Bộ lọc (3)" })).toBeInTheDocument();
  });

  it("không kết quả: GIỮ điều kiện (chip) và đưa lối gỡ từng mục, không tự xóa", async () => {
    await category("ao", { color: "xanh-navy", size: "s", in_stock: "1", price_max: "100000" });
    expect(screen.getByRole("heading", { name: "Không tìm thấy sản phẩm phù hợp" })).toBeInTheDocument();
    expect(screen.getByText("0 sản phẩm")).toBeInTheDocument();
    const chips = screen.getByRole("list", { name: "Bộ lọc đang áp" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(4);
    const remove = screen.getByRole("list", { name: "Gỡ điều kiện" });
    expect(within(remove).getAllByRole("link")).toHaveLength(4);
    expect(within(remove).getByRole("link", { name: "Bỏ lọc: Màu: Xanh navy" })).toHaveAttribute(
      "href",
      "/danh-muc/ao?size=s&price_max=100000&in_stock=1",
    );
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("tham số sai không gây 500: báo lỗi nhẹ, vẫn hiển thị danh sách với phần hợp lệ", async () => {
    await category("ao", { page: "abc", price_min: "1.5", color: "den", utm_source: "x" });
    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("không hợp lệ");
    expect(screen.getByText("5 sản phẩm")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(5);
  });

  it("khoảng giá sai (min > max): báo lỗi, giữ chip điều kiện, không gọi nguồn dữ liệu", async () => {
    await category("ao", { price_min: "900000", price_max: "100000" });
    expect(
      screen
        .getAllByRole("alert")
        .map((a) => a.textContent)
        .join(" "),
    ).toContain("lớn hơn");
    expect(screen.getByText("Chưa có số liệu")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Thử lại" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Bộ lọc đang áp" })).toBeInTheDocument();
  });

  it("sắp xếp là form GET chạy không cần JS: giữ điều kiện bằng input ẩn, về trang 1", async () => {
    await category("ao", { color: "den", sort: "price_asc", page: "1" });
    const select = screen.getByRole("combobox", { name: "Sắp xếp" }) as HTMLSelectElement;
    expect(select.value).toBe("price_asc");
    const form = select.closest("form")!;
    expect(form.method).toBe("get");
    expect(form.getAttribute("action")).toBe("/danh-muc/ao");
    const hidden = [...form.querySelectorAll("input[type=hidden]")].map(
      (i) => `${(i as HTMLInputElement).name}=${(i as HTMLInputElement).value}`,
    );
    expect(hidden).toEqual(["color=den"]);
    expect(within(form).getByRole("button", { name: "Áp dụng" })).toBeInTheDocument();
  });

  it("sidebar lọc desktop là form GET thuần (không JS) với trường đã tích theo URL", async () => {
    await category("ao", { color: "den", price_max: "500000" });
    const aside = screen.getByRole("complementary");
    const form = aside.querySelector("form")!;
    expect(form.method).toBe("get");
    expect(within(aside).getByRole("checkbox", { name: /Đen/ })).toBeChecked();
    expect(within(aside).getByRole("checkbox", { name: /Trắng/ })).not.toBeChecked();
    expect((within(aside).getByLabelText("Đến") as HTMLInputElement).value).toBe("500000");
    expect(within(aside).getByRole("button", { name: "Áp dụng bộ lọc" })).toHaveAttribute("type", "submit");
  });
});

describe("phân trang crawl được (catalog)", () => {
  it("trang 1: liên kết <a href> tới trang 2 có rel=next, không có prev", async () => {
    await searchPage();
    const nav = screen.getByRole("navigation", { name: "Phân trang" });
    const next = within(nav).getByRole("link", { name: "Trang sau" });
    expect(next).toHaveAttribute("href", "/tim-kiem?page=2");
    expect(next).toHaveAttribute("rel", "next");
    expect(within(nav).queryByRole("link", { name: "Trang trước" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Trang 1" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });

  it("trang 2: prev về URL gốc (không ?page=1), giữ điều kiện lọc trong liên kết", async () => {
    await searchPage({ page: "2", sort: "price_asc" });
    const nav = screen.getByRole("navigation", { name: "Phân trang" });
    const prev = within(nav).getByRole("link", { name: "Trang trước" });
    expect(prev).toHaveAttribute("href", "/tim-kiem?sort=price_asc");
    expect(prev).toHaveAttribute("rel", "prev");
    expect(within(nav).queryByRole("link", { name: "Trang sau" })).toBeNull();
    expect(screen.getAllByRole("article")).toHaveLength(4);
  });

  it("trang vượt tổng: trang rỗng có liên kết về trang 1, không 404/500", async () => {
    await searchPage({ page: "99" });
    expect(screen.getByRole("heading", { name: "Trang này không có sản phẩm" })).toBeInTheDocument();
    expect(hrefOf("Về trang 1")).toBe("/tim-kiem");
  });

  it("chỉ một trang → không hiện phân trang", async () => {
    await category("phu-kien");
    expect(screen.queryByRole("navigation", { name: "Phân trang" })).toBeNull();
  });
});

describe("trang tìm kiếm /tim-kiem (catalog)", () => {
  it("ô tìm có nhãn, role=search, giữ từ khóa; tìm có/không dấu ra kết quả", async () => {
    await searchPage({ q: "ÁO SƠ MI" });
    const form = screen.getByRole("search");
    expect(within(form).getByLabelText("Tìm theo tên, mã SKU hoặc danh mục")).toHaveValue("ÁO SƠ MI");
    expect(screen.getByRole("heading", { level: 1, name: "Kết quả cho “ÁO SƠ MI”" })).toBeInTheDocument();
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
    // Từ khóa ở ô tìm kiếm, không phải chip.
    expect(screen.queryByRole("list", { name: "Bộ lọc đang áp" })).toBeNull();
  });

  it("không kết quả: giữ từ khóa + điều kiện, gợi ý danh mục có sản phẩm", async () => {
    await searchPage({ q: "xyzxyz", color: "den" });
    expect(screen.getByRole("heading", { name: "Không tìm thấy sản phẩm phù hợp" })).toBeInTheDocument();
    const suggestions = screen.getByRole("list", { name: "Danh mục gợi ý" });
    expect(
      within(suggestions)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/danh-muc/ao", "/danh-muc/quan", "/danh-muc/vay", "/danh-muc/phu-kien"]);
    // 'Xóa tất cả' giữ từ khóa đang tìm.
    expect(hrefOf("Xóa tất cả")).toBe("/tim-kiem?q=xyzxyz");
  });

  it("từ khóa quá dài bị cắt ở 100 ký tự (không lỗi)", async () => {
    await searchPage({ q: "a".repeat(300) });
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.value.length).toBe(100);
  });
});

describe("SEO danh mục/tìm kiếm: index, canonical, rel prev/next (catalog)", () => {
  const meta = (slug: string, sp: Params) =>
    categoryMeta({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) });

  it("danh mục gốc: index,follow; canonical là chính nó", async () => {
    const m = await meta("ao", {});
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(m.alternates?.canonical).toBe("/danh-muc/ao");
    expect(m.title).toBe("Áo");
  });

  it("URL lọc tùy ý: noindex,follow; canonical chuẩn hóa thứ tự tham số", async () => {
    const m = await meta("ao", { size: "m", color: ["trang", "den"], utm_source: "zalo" });
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.alternates?.canonical).toBe("/danh-muc/ao?color=den%2Ctrang&size=m");
  });

  it("chỉ đổi sắp xếp cũng noindex; phân trang không lọc vẫn index với canonical riêng và prev/next", async () => {
    expect((await meta("ao", { sort: "price_desc" })).robots).toEqual({ index: false, follow: true });
    // Danh mục 'ao' chỉ 6 sản phẩm → dùng tìm kiếm cho prev/next; ở đây kiểm tra trang 2 danh mục.
    const p2 = await meta("ao", { page: "2" });
    expect(p2.robots).toEqual({ index: true, follow: true });
    expect(p2.alternates?.canonical).toBe("/danh-muc/ao?page=2");
    expect(p2.title).toBe("Áo – Trang 2");
    expect(p2.pagination).toEqual({ previous: "/danh-muc/ao", next: null });
  });

  it("tìm kiếm: luôn noindex,follow; rel next ở trang 1 và prev ở trang 2", async () => {
    const m1 = await searchMeta({ searchParams: Promise.resolve({}) });
    expect(m1.robots).toEqual({ index: false, follow: true });
    expect(m1.pagination).toEqual({ previous: null, next: "/tim-kiem?page=2" });
    const m2 = await searchMeta({ searchParams: Promise.resolve({ page: "2", q: "áo" }) });
    expect(m2.pagination?.previous).toBe("/tim-kiem?q=%C3%A1o");
    expect(m2.title).toBe("Tìm kiếm: áo – Trang 2");
  });
});

describe("API đếm cho drawer lọc (catalog)", () => {
  const call = (qs: string) => countRoute(new Request(`http://localhost/api/catalog/count?${qs}`));

  it("trả tổng theo bộ lọc nháp + danh mục, cache công khai ngắn", async () => {
    const res = await call("color=den&size=m&category=ao");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 4 });
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=60");
  });

  it("tham số sai hoặc danh mục lạ → 422", async () => {
    expect((await call("price_min=9&price_max=1")).status).toBe(422);
    expect((await call("category=khong-co")).status).toBe(422);
  });
});
