import { renderToStaticMarkup } from "react-dom/server";
import RootLayout from "./layout";
import NotFound from "./not-found";

function renderDoc(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html>${markup}`, "text/html");
}

describe("RootLayout", async () => {
  // RootLayout là async server component (đọc menu từ dữ liệu): lấy cây phần tử rồi dựng HTML tĩnh.
  const doc = renderDoc(renderToStaticMarkup(await RootLayout({ children: "nội dung thử" })));

  it("đặt lang=vi", () => {
    expect(doc.documentElement.getAttribute("lang")).toBe("vi");
  });

  it("có skip link trỏ tới main#noi-dung và là phần tử focus đầu tiên", () => {
    const skip = doc.querySelector("a.skip-link");
    expect(skip?.textContent).toBe("Bỏ qua tới nội dung");
    expect(skip?.getAttribute("href")).toBe("#noi-dung");
    expect(doc.body.querySelector("a")).toBe(skip);
    expect(doc.querySelector("main")?.id).toBe("noi-dung");
  });

  it("có đủ landmark header, main, footer; main chứa children", () => {
    expect(doc.querySelectorAll("header")).toHaveLength(1);
    expect(doc.querySelectorAll("main")).toHaveLength(1);
    expect(doc.querySelectorAll("footer")).toHaveLength(1);
    expect(doc.querySelector("main")?.textContent).toContain("nội dung thử");
  });

  it("header: logo chữ, menu danh mục từ dữ liệu, tìm kiếm, giỏ có số lượng", () => {
    const header = doc.querySelector("header")!;
    expect(header.querySelector("a[href='/']")?.textContent).toBe("X-SHOP");
    const nav = header.querySelector("nav[aria-label='Danh mục']")!;
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/danh-muc/ao", "/danh-muc/quan", "/danh-muc/vay", "/danh-muc/phu-kien"]);
    expect(header.querySelector("a[href='/tim-kiem']")?.textContent).toContain("Tìm kiếm");
    const cart = header.querySelector("a[href='/gio-hang']")!;
    expect(cart.textContent).toContain("Giỏ hàng, 0 sản phẩm");
  });

  it("header có nút mở menu di động với tên truy cập và aria-expanded=false", () => {
    const btn = doc.querySelector("header button[aria-haspopup='dialog']")!;
    expect(btn.textContent).toContain("Mở menu danh mục");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("footer: thông tin đơn vị bán là placeholder rõ ràng + 3 link chính sách", () => {
    const footer = doc.querySelector("footer")!;
    expect(footer.textContent).toContain("[Tên đơn vị bán — chủ shop điền]");
    const hrefs = [...footer.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/giao-hang", "/doi-tra-hoan-tien", "/bao-mat"]);
  });
});

describe("not-found", () => {
  it("có h1 tiếng Việt có dấu và đường về trang chủ", () => {
    const doc = renderDoc(renderToStaticMarkup(<NotFound />));
    expect(doc.querySelector("h1")?.textContent).toBe("Không tìm thấy trang");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("/");
  });
});
