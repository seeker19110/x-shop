import { renderToStaticMarkup } from "react-dom/server";
import RootLayout from "./layout";
import NotFound from "./not-found";

function renderDoc(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html>${markup}`, "text/html");
}

describe("RootLayout", () => {
  const doc = renderDoc(renderToStaticMarkup(<RootLayout>nội dung thử</RootLayout>));

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
});

describe("not-found", () => {
  it("có h1 tiếng Việt có dấu và đường về trang chủ", () => {
    const doc = renderDoc(renderToStaticMarkup(<NotFound />));
    expect(doc.querySelector("h1")?.textContent).toBe("Không tìm thấy trang");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("/");
  });
});
